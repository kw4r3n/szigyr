// DetMath oracle test (Q191): NOT part of `pnpm test`. Run: node scripts/detmath-oracle.ts
// For each DetMath function: 100,000 seeded random points plus a hard set (special values,
// reduction boundaries, near-pi multiples, subnormals). A Szigyr program evaluates the points
// under both backends; the two outputs must agree exactly (bit identity, with the sign of
// zero read off the reciprocal column). Every result is then compared against the correctly
// rounded value from MPFR (53-bit, round-to-nearest) via the test-only C oracle in
// scripts/detmath-oracle.c (libmpfr is a test-only dependency, see docs/DECISIONS.md).
// The distance of V8's Math.* from the same oracle is printed for reference only.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../packages/compiler/src/index.ts";
import { CFLAGS } from "../packages/compiler/src/native.ts";

const here = import.meta.dirname;
const dir = mkdtempSync(join(tmpdir(), "szigyr-detmath-oracle-"));
const exe = join(dir, "oracle");
execFileSync(process.env.CC ?? "cc", [...CFLAGS.filter((f) => f !== "-shared" && f !== "-fPIC"), join(here, "detmath-oracle.c"), "-lmpfr", "-lgmp", "-o", exe], { stdio: "inherit" });

// ---- seeded PRNG (mulberry32) ----
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- bit helpers ----
const dv = new DataView(new ArrayBuffer(8));
const bits = (v: number): bigint => { dv.setFloat64(0, v); return dv.getBigUint64(0); };
const fromBits = (b: bigint): number => { dv.setBigUint64(0, b); return dv.getFloat64(0); };
const hex = (v: number): string => bits(v).toString(16).padStart(16, "0");
const key = (v: number): bigint => { const b = bits(v); return (b & 0x8000000000000000n) ? (~b & 0xffffffffffffffffn) : (b | 0x8000000000000000n); };
const ulpDist = (a: number, b: number): bigint => { const d = key(a) - key(b); return d < 0n ? -d : d; };
const nextUp = (v: number): number => fromBits(bits(v) + 1n);
const nextDown = (v: number): number => fromBits(bits(v) - 1n);

// ---- point generation ----
const N = 100_000;
type Gen = (rnd: () => number) => number[];
const uni = (rnd: () => number, a: number, b: number): number => a + (b - a) * rnd();
const scaled = (rnd: () => number, kLo: number, kHi: number): number => (0.5 + rnd()) * 2 ** Math.floor(uni(rnd, kLo, kHi));
const sgn = (rnd: () => number): number => (rnd() < 0.5 ? -1 : 1);

const trigGen: Gen = (rnd) => {
  const out: number[] = [];
  while (out.length < N) {
    const r = rnd();
    if (r < 0.4) out.push(uni(rnd, -1000, 1000));
    else if (r < 0.7) out.push(sgn(rnd) * (1 + rnd()) * 2 ** Math.floor(uni(rnd, -30, 31)));
    else if (r < 0.9) out.push(sgn(rnd) * (1 + rnd()) * 2 ** Math.floor(uni(rnd, 31, 300)));
    else { const n = Math.floor(rnd() * 2 ** 62); out.push(n * Math.PI * (1 + (rnd() - 0.5) * 1e-12)); }
  }
  return out;
};
const expGen: Gen = (rnd) => {
  const out: number[] = [];
  while (out.length < N) {
    const r = rnd();
    if (r < 0.5) out.push(uni(rnd, -750, 710));
    else if (r < 0.8) out.push(uni(rnd, -2, 2));
    else out.push(sgn(rnd) * (1 + rnd()) * 2 ** Math.floor(uni(rnd, -10, 11)));
  }
  return out;
};
const logGen: Gen = (rnd) => {
  const out: number[] = [];
  while (out.length < N) {
    const r = rnd();
    if (r < 0.4) out.push(scaled(rnd, -1073, 1024));
    else if (r < 0.7) out.push(uni(rnd, 1e-300, 1e6));
    else out.push(1 + (rnd() - 0.5) * 2 ** Math.floor(uni(rnd, -52, -10)));
  }
  return out;
};
const atanGen: Gen = (rnd) => {
  const out: number[] = [];
  while (out.length < N) {
    const r = rnd();
    if (r < 0.4) out.push(uni(rnd, -100, 100));
    else if (r < 0.8) out.push(sgn(rnd) * (1 + rnd()) * 2 ** Math.floor(uni(rnd, -30, 65)));
    else if (r < 0.9) out.push(uni(rnd, -1e-8, 1e-8));
    else out.push(sgn(rnd) * (1 + rnd()) * 2 ** Math.floor(uni(rnd, 65, 1000)));
  }
  return out;
};
const tanhGen: Gen = (rnd) => {
  const out: number[] = [];
  while (out.length < N) {
    const r = rnd();
    if (r < 0.5) out.push(uni(rnd, -25, 25));
    else if (r < 0.8) out.push(uni(rnd, -1, 1));
    else if (r < 0.9) out.push(uni(rnd, -1e-15, 1e-15));
    else out.push(sgn(rnd) * uni(rnd, 22, 1000));
  }
  return out;
};

const PI4 = 0.7853981633974483;
const HARD: Record<string, number[]> = {
  sin: [0, -0, PI4, nextUp(PI4), nextDown(PI4), 1647100, 1647101, nextDown(1647101), 1e15, -1e15, 123456789.12345679, 3141592.653589793, 1e300, -1e300, 5e-324, -5e-324, 1.5707963267948966, Infinity, -Infinity, NaN],
  cos: [0, -0, PI4, nextUp(PI4), 1647100, 1647101, 1e15, -1e15, 1e300, -1e300, 5e-324, 999999999999.9999, Infinity, -Infinity, NaN],
  tan: [0, -0, PI4, nextDown(PI4), 1647100, 1647101, 1.5707963267948966, nextDown(1.5707963267948966), 1e15, -1e15, 1e300, 5e-324, Infinity, -Infinity, NaN],
  exp: [0, -0, 709.782712893384, nextUp(709.782712893384), -745.1332191019411, nextDown(-745.1332191019411), -744.4400719213812, 710, -746, 1, -1, 1e-300, -1e-300, Infinity, -Infinity, NaN],
  log: [1, 2, 0.5, 5e-324, 2.2250738585072014e-308, nextUp(2.2250738585072014e-308), 1.7976931348623157e308, 0, -0, -1, 0.9999999999999999, nextUp(1), Infinity, NaN],
  log10: [1, 10, 1000, 0.5, 5e-324, 1.7976931348623157e308, 0, -0, -1, 0.9999999999999999, nextUp(1), Infinity, NaN],
  atan: [0, -0, 1, -1, 0.4375, nextUp(0.4375), 0.6875, 1.1875, 2.4375, nextDown(2.4375), 1.8446744073709552e19, 5e-324, Infinity, -Infinity, NaN],
  tanh: [0, -0, 1, -1, 22, -22, nextDown(22), 2.7755575615628914e-17, nextUp(2.7755575615628914e-17), 0.9999999999999999, Infinity, -Infinity, NaN],
};
const UNARY: Record<string, Gen> = { sin: trigGen, cos: trigGen, tan: trigGen, exp: expGen, log: logGen, log10: logGen, atan: atanGen, tanh: tanhGen };

const atan2Gen = (rnd: () => number): [number, number][] => {
  const out: [number, number][] = [];
  while (out.length < N) {
    const r = rnd();
    let y: number, x: number;
    if (r < 0.6) { y = sgn(rnd) * scaled(rnd, -1073, 1024); x = sgn(rnd) * scaled(rnd, -1073, 1024); }
    else if (r < 0.8) { y = uni(rnd, -1000, 1000); x = uni(rnd, -1000, 1000); }
    else { y = sgn(rnd) * scaled(rnd, -100, 100); x = y * (1 + (rnd() - 0.5) * 1e-9); }
    out.push([y, x]);
  }
  for (const y of [0, -0, 1, -1, Infinity, -Infinity, NaN, 5e-324, -5e-324])
    for (const x of [0, -0, 1, -1, Infinity, -Infinity, NaN, 5e-324, -5e-324]) out.push([y, x]);
  return out;
};
const powGen = (rnd: () => number): [number, number][] => {
  const out: [number, number][] = [];
  while (out.length < N) {
    const r = rnd();
    if (r < 0.35) out.push([(0.5 + rnd()) * 2 ** Math.floor(uni(rnd, -300, 301)), uni(rnd, -64, 64)]);
    else if (r < 0.6) out.push([1 + (rnd() - 0.5) * 0.01, rnd() < 0.5 ? uni(rnd, -1e6, 1e6) : sgn(rnd) * 2 ** Math.floor(uni(rnd, 0, 57))]);
    else if (r < 0.75) out.push([-(1 + Math.floor(rnd() * 1000)), Math.floor(uni(rnd, -64, 65))]);
    else if (r < 0.9) out.push([(0.5 + rnd()) * 2 ** Math.floor(uni(rnd, -500, 501)), uni(rnd, -10, 10)]);
    else { const j = 1 + Math.floor(rnd() * 1000); out.push([rnd() < 0.5 ? nextUp(1) + (j - 1) * 2.220446049250313e-16 : 1 - j * 1.1102230246251565e-16, sgn(rnd) * uni(rnd, 1e15, 1e17)]); }
  }
  const hard: [number, number][] = [
    [1, NaN], [-1, Infinity], [1, -Infinity], [NaN, 0], [0, 0], [0, -1], [-0, -3], [-0, 3], [-0, -2], [-0, 2], [-0, 0.5],
    [2, 1023], [2, -1074], [2, 1024], [2, -1075], [10, 308], [10, 309], [-2, 0.5], [-8, 1 / 3], [1e300, 2], [1e-300, -2],
    [5e-324, 1], [5e-324, -1], [0.9999999999999999, 1e17], [1.0000000000000002, -1e17], [-1, 0.5], [3, -0], [-1, 3], [-1, 4],
    [0, Infinity], [0, -Infinity], [0.5, Infinity], [0.5, -Infinity], [2, Infinity], [2, -Infinity], [Infinity, -1], [-Infinity, -3], [-Infinity, 3],
  ];
  return out.concat(hard);
};

// ---- Szigyr evaluation ----
const lit = (v: number): string => {
  if (Number.isNaN(v)) return "(0 / 0)";
  if (v === Infinity) return "(1 / 0)";
  if (v === -Infinity) return "(-1 / 0)";
  if (Object.is(v, -0)) return "-0";
  return String(v);
};

async function evaluate(fn: string, pts: number[]): Promise<string[]> {
  const isBinary = fn === "atan2" || fn === "pow";
  writeFileSync(join(dir, "points.ts"), `export function points(): Array<f64> { return [${pts.map(lit).join(", ")}]; }\n`);
  const call = isBinary ? `DetMath.${fn}(P[i], P[i + 1])` : `DetMath.${fn}(P[i])`;
  writeFileSync(join(dir, "main.ts"), [
    'import { points } from "./points.ts";',
    "export function main(sys: System): void {",
    "  const P = points();",
    `  for (let i: usize = 0; i < P.length; i += ${isBinary ? 2 : 1}) {`,
    `    const v = ${call};`,
    "    sys.log.info(`${v} ${1 / v}`);",
    "  }",
    "}",
    "",
  ].join("\n"));
  const outs: string[] = [];
  for (const backend of ["js", "c"] as const) {
    const r = await run(join(dir, "main.ts"), { backend });
    if (r.diagnostics.length || r.trap) throw new Error(`${fn} (${backend}): ${JSON.stringify(r.diagnostics.length ? r.diagnostics : r.trap)}`);
    outs.push(r.stdout);
  }
  if (outs[0] !== outs[1]) {
    const a = outs[0]!.split("\n"), b = outs[1]!.split("\n");
    const i = a.findIndex((l, j) => l !== b[j]);
    throw new Error(`${fn}: JS and C backends differ at line ${i}: js=${a[i]} c=${b[i]}`);
  }
  return outs[0]!.replace(/\n$/, "").split("\n");
}

// ---- oracle comparison ----
function compare(fn: string, pts: number[], lines: string[]): { n: number; maxUlp: bigint; over1: number; mismatch: number; v8Max: bigint; v8Over1: number } {
  const isBinary = fn === "atan2" || fn === "pow";
  const count = isBinary ? pts.length / 2 : pts.length;
  const input: string[] = [];
  for (let i = 0; i < count; i++) {
    if (!isBinary) input.push(`${fn} ${hex(pts[i]!)}`);
    else if (fn === "atan2") input.push(`atan2 ${hex(pts[2 * i + 1]!)} ${hex(pts[2 * i]!)}`); // oracle line is x, y
    else input.push(`pow ${hex(pts[2 * i]!)} ${hex(pts[2 * i + 1]!)}`);
  }
  const res = spawnSync(exe, [], { input: input.join("\n") + "\n", encoding: "utf8", maxBuffer: 1 << 28 });
  if (res.status !== 0) throw new Error(`oracle failed for ${fn}: ${res.stderr}`);
  const want = res.stdout.replace(/\n$/, "").split("\n").map((h) => fromBits(BigInt(`0x${h}`)));
  if (want.length !== count) throw new Error(`${fn}: oracle returned ${want.length} values for ${count} points`);
  let maxUlp = 0n, over1 = 0, mismatch = 0, v8Max = 0n, v8Over1 = 0;
  const checkOne = (got: number, w: number): bigint | null => { // null = ok (exact class match)
    if (Number.isNaN(w)) return Number.isNaN(got) ? null : -1n;
    if (!Number.isFinite(w)) return got === w ? null : -1n;
    if (Number.isNaN(got) || !Number.isFinite(got)) return -1n;
    if (w === 0) return got === 0 && Object.is(got, w) ? 0n : -1n; // the sign of zero must match
    return ulpDist(got, w);
  };
  for (let i = 0; i < count; i++) {
    const [rs, cs] = lines[i]!.split(" ");
    let got = Number(rs);
    if (got === 0 && cs === "-Infinity") got = -0;
    let w = want[i]!;
    if (fn === "pow") {
      const px = pts[2 * i]!, py = pts[2 * i + 1]!;
      if ((px === 1 && Number.isNaN(py)) || (Math.abs(px) === 1 && !Number.isFinite(py))) w = NaN; // ECMAScript, not IEEE
    }
    const d = checkOne(got, w);
    if (d === null) { /* NaN / Inf class match */ }
    else if (d < 0n) mismatch++;
    else { if (d > maxUlp) maxUlp = d; if (d > 1n) over1++; }
    // V8's own Math.* on the same point, for reference (Math.tanh is not in the §12
    // allowlist, so this is computed here in the driver, on the same V8).
    const v8v = !isBinary ? (Math as unknown as Record<string, (a: number) => number>)[fn]!(pts[i]!)
      : fn === "atan2" ? Math.atan2(pts[2 * i]!, pts[2 * i + 1]!) : Math.pow(pts[2 * i]!, pts[2 * i + 1]!);
    const dv8 = checkOne(v8v, w);
    if (dv8 !== null && dv8 >= 0n) { if (dv8 > v8Max) v8Max = dv8; if (dv8 > 1n) v8Over1++; }
  }
  return { n: count, maxUlp, over1, mismatch, v8Max, v8Over1 };
}

let bad = false;
console.log("| function | points | JS = C bits | max ulp vs MPFR | over 1 ulp | mismatches | V8 max ulp (reference) |");
console.log("| --- | ---: | --- | ---: | ---: | ---: | ---: |");
for (const [i, fn] of ["sin", "cos", "tan", "atan", "exp", "log", "log10", "tanh", "atan2", "pow"].entries()) {
  const rnd = mulberry32(0xc0ffee + i * 7919);
  let pts: number[], flat: number[];
  if (fn === "atan2") { const pairs = atan2Gen(rnd); flat = pairs.flat(); pts = flat; }
  else if (fn === "pow") { const pairs = powGen(rnd); flat = pairs.flat(); pts = flat; }
  else { pts = UNARY[fn]!(rnd).concat(HARD[fn]!); flat = pts; }
  const lines = await evaluate(fn, flat);
  const r = compare(fn, flat, lines);
  if (r.maxUlp > 1n || r.over1 > 0 || r.mismatch > 0) bad = true;
  console.log(`| ${fn} | ${r.n} | yes | ${r.maxUlp} | ${r.over1} | ${r.mismatch} | ${r.v8Max} (${r.v8Over1} over) |`);
}
if (bad) { console.error("DetMath oracle: FAILED"); process.exit(1); }
console.log("DetMath oracle: all functions within 1 ulp of the correctly rounded value, JS and C bit-identical.");

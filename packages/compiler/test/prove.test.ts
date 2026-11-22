import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { main as cliMain } from "../src/cli.ts";
import { emitC } from "../src/emit-c.ts";
import {
  analyze,
  buildBrowser,
  buildNode,
  createParser,
  detectSolver,
  parseGetValue,
  prove,
  runSmtBatch,
  shutdownSmt,
} from "../src/index.ts";
import { serveMcp } from "../src/mcp.ts";

const tmpRoots: string[] = [];
function makeTmp(prefix = "szigyr-prove-"): { dir: string; cacheFile: string } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return { dir, cacheFile: join(dir, ".szigyr-cache", "prove.json") };
}

function writeTmpFile(dir: string, name: string, src: string): string {
  const p = join(dir, name);
  writeFileSync(p, src);
  return p;
}

async function runCli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "", err = "";
  const code = await cliMain(argv, (s) => { out += s; }, (s) => { err += s; });
  return { code, out, err };
}

function jsonLines(s: string): Record<string, any>[] {
  return s.trim().split(/\n+/).filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);
}

function cFnBody(code: string, name: string): string {
  const m = new RegExp(`sz_F\\d+_${name}(?:_I\\d+)?\\([^)]*\\) \\{`).exec(code);
  if (!m) throw new Error(`missing C body for ${name}`);
  let depth = 0;
  const start = m.index;
  for (let i = code.indexOf("{", start); i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}" && --depth === 0) return code.slice(start, i + 1);
  }
  throw new Error(`unterminated C body for ${name}`);
}

function hasSdl3(): boolean {
  try {
    execFileSync("pkg-config", ["--exists", "sdl3"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const parser = createParser();

afterAll(async () => {
  await shutdownSmt();
  parser.close();
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

describe("Stage 6 SMT prover & release check elimination", () => {
  it("detects SMT solver, parses get-value outputs, and solves unsat/sat batches", async () => {
    const info = detectSolver();
    expect(["z3", "cvc5", "z3-wasm", "custom"]).toContain(info.kind);
    expect(info.id.length).toBeGreaterThan(0);

    const parsed = parseGetValue(
      "((x_1 42) (y_2 (- 2147483648)) (big_3 9007199254740993) (flag_4 true) (sym_5 false))",
      new Map([
        ["x_1", "x"],
        ["y_2", "y"],
        ["big_3", "big"],
        ["flag_4", "flag"],
        ["sym_5", "negFlag"],
      ]),
    );
    expect(parsed).toEqual({
      x: 42,
      y: -2147483648,
      big: "9007199254740993",
      flag: true,
      negFlag: false,
    });

    const preamble = [
      "(declare-const n Int)",
      "(declare-const i Int)",
      "(assert (>= n 1))",
    ].join("\n");
    const mv = new Map([["n", "n"], ["i", "i"]]);
    const res = await runSmtBatch(preamble, [
      { assertion: "(and (>= i 0) (< i n) (not (and (>= i 0) (< i n))))", modelVars: mv },
      { assertion: "(and (>= i 0) (<= i n) (not (< i n)))", modelVars: mv },
    ], { logic: "QF_LIA", timeoutMs: 2000 });

    expect(res[0]!.status).toBe("unsat");
    expect(res[1]!.status).toBe("sat");
    expect(res[1]!.model).toBeDefined();
    expect(typeof res[1]!.model!.n).toBe("number");
    expect(res[1]!.model!.i).toBe(res[1]!.model!.n);
  });

  it("proves strict/rt numeric kernels (dot, saxpy, prefix, stencil, particles) and eliminates bounds checks in release emitC", async () => {
    const { dir, cacheFile } = makeTmp();
    const src = `
type P = Struct<{ readonly x: f32; readonly y: f32; readonly vx: f32; readonly vy: f32 }>;

function dotInner(a: Ref<Slice<f32>>, b: Ref<Slice<f32>>): f32 {
  "use rt";
  requires(a.length <= b.length);
  let acc: f32 = 0;
  for (let i: usize = 0; i < a.length; i += 1) acc += a[i] * b[i];
  return acc;
}

export function dot(a: Ref<Slice<f32>>, b: Ref<Slice<f32>>): f32 {
  "use rt";
  requires(a.length <= b.length);
  return dotInner(a, b);
}

export function saxpy(k: f32, x: Ref<Slice<f32>>, y: Mut<Slice<f32>>): void {
  "use rt";
  requires(y.length <= x.length);
  for (let i: usize = 0; i < y.length; i += 1) y[i] = k * x[i] + y[i];
}

export function prefix(s: Mut<Slice<i32>>): i32 {
  "use rt";
  requires(s.length >= 1);
  for (let i: usize = 1; i < s.length; i += 1) s[i] = s[i] + s[i - 1];
  return s[s.length - 1];
}

export function stencil(a: Ref<Slice<f64>>, out: Mut<Slice<f64>>): f64 {
  "use rt";
  requires(a.length >= 2 && a.length <= out.length);
  for (let i: usize = 1; i + 1 < a.length; i += 1) out[i] = (a[i - 1] + a[i] + a[i + 1]) / 3;
  return out[divTrunc(a.length, 2)];
}

export function particles(ps: Mut<Vec<P>>, dt: f32): f32 {
  "use rt";
  let e: f32 = 0;
  for (let i: usize = 0; i < ps.length; i += 1) {
    const p = ps[i];
    const vy: f32 = p.vy - 9.75 * dt;
    ps[i] = { x: p.x + p.vx * dt, y: p.y + vy * dt, vx: p.vx, vy };
    e += vy * vy;
  }
  return e;
}

function idGeneric<T extends Copy & Native>(s: Ref<Slice<T>>, i: usize): T {
  "use rt";
  requires(i < s.length);
  return s[i];
}

export function useGeneric(s: Ref<Slice<i32>>): i32 {
  "use rt";
  if (s.length === 0) return 0;
  return idGeneric<i32>(s, 0);
}

function applyFn(s: Ref<Slice<i32>>, f: (x: i32) => i32): i32 {
  "use rt";
  return f(s[0]);
}
function addOne(x: i32): i32 { "use rt"; return wrapAdd(x, 1); }
export function callApplyFn(s: Ref<Slice<i32>>): i32 {
  "use rt";
  if (s.length === 0) return 0;
  return applyFn(s, addOne);
}
`;
    const file = writeTmpFile(dir, "kernels.szigyr", src);
    const analysis = analyze(file, parser);
    expect(analysis.diagnostics).toEqual([]);

    const res = await prove(file, { analysis, cacheFile, parser });
    expect(res.diagnostics).toEqual([]);

    const byFn = new Map(res.functions.map((f) => [f.fn, f]));
    expect(byFn.get("dotInner")!.summary).toMatchObject({ failed: 0, unknown: 0, timeout: 0 });
    // Private `dotInner` has every T001/T002/T004 cleared!
    expect(byFn.get("dotInner")!.remainingRtTrapSites).toEqual([]);
    // Exported kernels keep only their own entry `requires` (T004); every bounds (T002) and index arithmetic (T001) site is proved
    expect(byFn.get("dot")!.remainingRtTrapSites?.map((s) => s.code)).toEqual(["T004"]);
    expect(byFn.get("saxpy")!.summary).toMatchObject({ failed: 0, unknown: 0, timeout: 0 });
    expect(byFn.get("saxpy")!.remainingRtTrapSites?.map((s) => s.code)).toEqual(["T004"]);
    expect(byFn.get("stencil")!.summary).toMatchObject({ failed: 0, unknown: 0, timeout: 0 });
    expect(byFn.get("stencil")!.remainingRtTrapSites?.map((s) => s.code)).toEqual(["T004"]);
    expect(byFn.get("particles")!.summary).toMatchObject({ failed: 0, unknown: 0, timeout: 0 });
    expect(byFn.get("particles")!.remainingRtTrapSites).toEqual([]);

    // `prefix`: all T002 bounds checks and index T001 checks proved; only exported `requires` (T004) and `s[i] + s[i - 1]` i32 overflow (T001) can trap
    const prefixRes = byFn.get("prefix")!;
    expect(prefixRes.obligations.filter((o) => o.kind === "T002").every((o) => o.status === "proved")).toBe(true);
    expect(prefixRes.remainingRtTrapSites?.map((s) => s.code).sort()).toEqual(["T001", "T004"]);

    // Dev C output keeps `sz_chk`; release C eliminates `sz_chk` from all kernels
    const devC = emitC(analysis.decls!, "native")!;
    const relC = emitC(analysis.decls!, "native", { proved: res.proved })!;
    expect(devC.c).toContain("sz_chk(");
    expect(relC.eliminated).toBeGreaterThanOrEqual(15);

    expect(cFnBody(relC.c, "dotInner")).not.toContain("sz_chk(");
    expect(cFnBody(relC.c, "dotInner")).not.toContain("SZ_AOP(");
    expect(cFnBody(relC.c, "dotInner")).not.toContain("sz_trap(4,");
    expect(cFnBody(relC.c, "saxpy")).not.toContain("sz_chk(");
    expect(cFnBody(relC.c, "saxpy")).not.toContain("SZ_AOP(");
    expect(cFnBody(relC.c, "prefix")).not.toContain("sz_chk(");
    expect(cFnBody(relC.c, "prefix")).toContain("SZ_AOP(add, int32_t");
    expect(cFnBody(relC.c, "stencil")).not.toContain("sz_chk(");
    expect(cFnBody(relC.c, "stencil")).not.toContain("SZ_DIV(");
    expect(cFnBody(relC.c, "particles")).not.toContain("sz_chk(");

    // Parametric generic functions eliminate proved bounds checks; fn-param specializations keep checks
    expect(byFn.get("idGeneric")!.summary).toMatchObject({ failed: 0, unknown: 0, timeout: 0 });
    expect(cFnBody(relC.c, "idGeneric")).not.toContain("sz_chk(");
    expect(byFn.has("applyFn")).toBe(false);
    expect(cFnBody(relC.c, "applyFn")).toContain("sz_chk(");
  });

  it("proves and eliminates T001, T002 (.slice), T003, T004 (private requires), T005, T007, T009, T010", async () => {
    const { dir, cacheFile } = makeTmp();
    const src = `
function privHelper(x: i32): i32 {
  "use rt";
  requires(x >= 0 && x <= 100);
  ensures((r: i32) => r >= 1 && r <= 101);
  return x + 1;
}

export function callPriv(n: i32): i32 {
  "use rt";
  requires(n >= 0 && n <= 100);
  ensures((r: i32) => r >= 2 && r <= 102);
  return privHelper(n) + 1;
}

function firstByte(sub: Ref<Slice<u8>>): u8 {
  "use rt";
  requires(sub.length >= 1);
  return sub[0];
}

export function sliceCastShiftDivRem(
  s: Ref<Slice<u8>>,
  a: usize,
  b: usize,
  k: i32,
  sh: u32,
  d: i32,
  f: f64,
): u32 {
  "use rt";
  requires(a <= b && b <= s.length);
  requires(b - a >= 1);
  requires(k >= 0 && k <= 255);
  requires(sh < 32);
  requires(d !== 0);
  const first = u8(k);
  const sft = u32(firstByte(s.slice(a, b))) << sh;
  const q = rem(d, -1); // T007 only (rem(MIN, -1) never traps T001)
  const one: u32 = 1;
  const ten: u32 = 10;
  const zeroU: u32 = 0;
  const fq = divTrunc(u32(k) + ten, one + sh);
  const cvtFloat = i32(f); // unmodeled float cast stays unknown and keeps sz_cvt
  if (cvtFloat > 100000) return u32(first) + sft + fq + (q > 0 ? one : zeroU);
  return u32(first) + sft + fq;
}

export function negSafe(x: i32): i32 {
  "use rt";
  requires(x > -2147483648);
  return -x;
}

export function divSafe(a: i32, b: i32): i32 {
  "use rt";
  requires(b !== 0 && !(a === -2147483648 && b === -1));
  return divTrunc(a, b);
}

export function whileWithInv(s: Ref<Slice<i32>>): i32 {
  "use rt";
  let i: usize = 0;
  let sum: i32 = 0;
  while (i < s.length) {
    invariant(i <= s.length);
    const v = s[i];
    if (v > 0 && sum < 1000000 && v < 1000) sum += v;
    i += 1;
  }
  return sum;
}
`;
    const file = writeTmpFile(dir, "all-kinds.szigyr", src);
    const analysis = analyze(file, parser);
    expect(analysis.diagnostics).toEqual([]);

    const res = await prove(file, { analysis, cacheFile, parser });
    const byFn = new Map(res.functions.map((f) => [f.fn, f]));

    expect(byFn.get("privHelper")!.summary).toMatchObject({ failed: 0, unknown: 0, timeout: 0 });
    expect(byFn.get("callPriv")!.summary).toMatchObject({ failed: 0, unknown: 0, timeout: 0 });
    expect(byFn.get("firstByte")!.summary).toMatchObject({ failed: 0, unknown: 0, timeout: 0 });
    expect(byFn.get("firstByte")!.remainingRtTrapSites).toEqual([]);
    expect(byFn.get("negSafe")!.summary).toMatchObject({ failed: 0, unknown: 0, timeout: 0 });
    expect(byFn.get("divSafe")!.summary).toMatchObject({ failed: 0, unknown: 0, timeout: 0 });
    expect(byFn.get("whileWithInv")!.summary).toMatchObject({ failed: 0, unknown: 0, timeout: 0 });

    const sc = byFn.get("sliceCastShiftDivRem")!;
    expect(sc.summary.failed).toBe(0);
    // Float cast stays unknown (never failed, never eliminated)
    expect(sc.obligations.find((o) => o.kind === "T003" && o.label.includes("float"))?.status).toBe("unknown");
    expect(sc.obligations.filter((o) => o.kind === "T002").every((o) => o.status === "proved")).toBe(true);
    expect(sc.obligations.filter((o) => o.kind === "T007").every((o) => o.status === "proved")).toBe(true);
    expect(sc.obligations.filter((o) => o.kind === "T009").every((o) => o.status === "proved")).toBe(true);

    const relC = emitC(analysis.decls!, "native", { proved: res.proved })!.c;

    // Private `privHelper` and `firstByte` have requires (T004) + ensures (T005) + bounds (T002) eliminated
    expect(cFnBody(relC, "privHelper")).not.toContain("sz_trap(4,");
    expect(cFnBody(relC, "privHelper")).not.toContain("sz_trap(5,");
    expect(cFnBody(relC, "firstByte")).not.toContain("sz_trap(4,");
    expect(cFnBody(relC, "firstByte")).not.toContain("sz_chk(");
    // Exported `callPriv` keeps its runtime `requires` (sz_trap(4)), but eliminates `ensures` (sz_trap(5))
    expect(cFnBody(relC, "callPriv")).toContain("sz_trap(4,");
    expect(cFnBody(relC, "callPriv")).not.toContain("sz_trap(5,");
    // Proved neg, div, while invariant, slice/cast/shift/rem all eliminated; float cast keeps sz_cvt
    expect(cFnBody(relC, "negSafe")).not.toContain("SZ_AOP(");
    expect(cFnBody(relC, "divSafe")).not.toContain("SZ_DIV(");
    expect(cFnBody(relC, "whileWithInv")).not.toContain("sz_trap(10,");
    expect(cFnBody(relC, "whileWithInv")).not.toContain("sz_chk(");
    expect(cFnBody(relC, "whileWithInv")).not.toContain("SZ_AOP(");
    expect(cFnBody(relC, "sliceCastShiftDivRem")).not.toContain("sz_sub(");
    expect(cFnBody(relC, "sliceCastShiftDivRem")).not.toContain("sz_cvti(");
    expect(cFnBody(relC, "sliceCastShiftDivRem")).not.toContain("sz_amt(");
    expect(cFnBody(relC, "sliceCastShiftDivRem")).not.toContain("SZ_DIV(");
    expect(cFnBody(relC, "sliceCastShiftDivRem")).not.toContain("SZ_REM(");
    expect(cFnBody(relC, "sliceCastShiftDivRem")).toContain("sz_cvt(");
  });

  it("reports counterexamples and refuses elimination for buggy contracts, a[i]=b[i], divTrunc MIN/-1, and bitwise/float ops", async () => {
    const { dir, cacheFile } = makeTmp();
    const src = `
export function oobCopy(a: Mut<Slice<i32>>, b: Ref<Slice<i32>>, i: usize): void {
  "use rt";
  requires(a.length === b.length);
  a[i] = b[i];
}

export function oobCopyDiff(a: Mut<Slice<i32>>, b: Ref<Slice<i32>>, i: usize): void {
  "use rt";
  a[i] = b[i];
}

export function divMinBad(a: i32): i32 {
  "use rt";
  return divTrunc(a, -1);
}

export function badEnsures(x: i32): i32 {
  "use rt";
  ensures((r: i32) => r > x);
  if (x < 2147483647) return x + 1;
  return x;
}

export function badInv(): i32 {
  "use rt";
  let i: i32 = 0;
  while (i < 5) {
    invariant(i < 5);
    i += 1;
  }
  return i;
}

export function unmodeledBitwise(x: i32, mask: i32): i32 {
  "use rt";
  const y = x & mask;
  return y + 1;
}

export function exposedByManaged(x: i32): i32 {
  return privCalledByManaged(x);
}

function privCalledByManaged(x: i32): i32 {
  "use rt";
  requires(x >= 0);
  return x;
}
`;
    const file = writeTmpFile(dir, "negative.szigyr", src);
    const analysis = analyze(file, parser);
    expect(analysis.diagnostics).toEqual([]);

    const res = await prove(file, { analysis, cacheFile, parser });
    const byFn = new Map(res.functions.map((f) => [f.fn, f]));

    // Soundness check: in `a[i] = b[i]`, RHS `b[i]` evaluates first (fails with counterexample); LHS `a[i]` is dominated by `b[i]` when `a.length === b.length`.
    const oobObs = byFn.get("oobCopy")!.obligations.filter((o) => o.kind === "T002");
    expect(oobObs.length).toBe(2);
    expect(oobObs.some((o) => o.status === "failed" && o.counterexample !== undefined)).toBe(true);
    // Without `a.length === b.length`, BOTH `b[i]` and `a[i]` fail!
    const diffObs = byFn.get("oobCopyDiff")!.obligations.filter((o) => o.kind === "T002");
    expect(diffObs.length).toBe(2);
    expect(diffObs.every((o) => o.status === "failed")).toBe(true);

    // `divTrunc(a, -1)`: T007 divisor != 0 proved, T001 MIN / -1 fails with a = -2147483648!
    const divObs = byFn.get("divMinBad")!.obligations;
    expect(divObs.find((o) => o.kind === "T007")?.status).toBe("proved");
    const minFail = divObs.find((o) => o.kind === "T001");
    expect(minFail?.status).toBe("failed");
    expect(minFail?.counterexample?.a).toBe(-2147483648);

    // `badEnsures`: fails at x = 2147483647
    const ensFail = byFn.get("badEnsures")!.obligations.find((o) => o.kind === "T005");
    expect(ensFail?.status).toBe("failed");
    expect(ensFail?.counterexample?.x).toBe(2147483647);

    // `badInv`: fails step
    expect(byFn.get("badInv")!.obligations.some((o) => o.kind === "T010" && o.status === "failed")).toBe(true);

    // Bitwise `x & mask` makes `y + 1` fail closed to `unknown`
    expect(byFn.get("unmodeledBitwise")!.obligations.find((o) => o.kind === "T001")?.status).toBe("unknown");

    // `privCalledByManaged` is called from a managed function -> NOT in provedPrivateRequires
    expect([...res.proved.provedPrivateRequires].map((f) => f.name)).not.toContain("privCalledByManaged");

    const relC = emitC(analysis.decls!, "native", { proved: res.proved })!.c;
    expect(cFnBody(relC, "divMinBad")).toContain("SZ_DIV(");
    expect(cFnBody(relC, "oobCopy")).toContain("sz_chk(");
    expect(cFnBody(relC, "privCalledByManaged")).toContain("sz_trap(4,");
  });

  it("preserves runtime behavior and traps in buildNode (C & Wasm) and buildBrowser release builds", async () => {
    const { dir, cacheFile } = makeTmp();
    const src = `
function addPos(x: i32, y: i32): i32 {
  "use rt";
  requires(x >= 0 && y >= 0 && x <= 10000 && y <= 100);
  return x + y;
}

export function sumSafe(xs: Ref<Slice<i32>>, d: i32): i32 {
  "use rt";
  requires(xs.length >= 1 && xs.length <= 10 && d !== 0);
  let total: i32 = 0;
  for (let i: usize = 0; i < xs.length; i += 1) {
    invariant(total >= 0 && total <= 10000);
    const v = xs[i];
    if (v >= 0 && v <= 100 && total <= 1000) total = addPos(total, v);
  }
  const r = rem(d, -1);
  const bonus: i32 = r === 0 ? 0 : 1;
  return total + bonus;
}

export function minRem(a: i32, b: i32): i32 {
  "use rt";
  requires(b !== 0);
  return rem(a, b);
}

export function atIdx(xs: Ref<Slice<i32>>, i: usize): i32 {
  "use rt";
  return xs[i];
}

export function runValid(sys: System): void {
  const v = Vec.create<i32>(sys.alloc, 3);
  v.push(10); v.push(20); v.push(30);
  sys.log.info(\`sum=\${sumSafe(v, -1)},min=\${minRem(-2147483648, -1)}\`);
}

export function runTrapIdx(sys: System): void {
  const v = Vec.create<i32>(sys.alloc, 3);
  v.push(10); v.push(20); v.push(30);
  atIdx(v, 99);
}

export function runTrapReq(sys: System): void {
  const v = Vec.create<i32>(sys.alloc, 3);
  v.push(10); v.push(20); v.push(30);
  sumSafe(v, 0);
}
`;
    const file = writeTmpFile(dir, "lib.szigyr", src);
    const analysis = analyze(file, parser);
    expect(analysis.diagnostics).toEqual([]);
    const pr = await prove(file, { analysis, cacheFile, parser });
    expect(pr.summary.failed).toBe(1); // only `atIdx` `xs[i]`

    const nodeCDev = buildNode(file, { outDir: join(dir, "out-c-dev"), mode: "lib", backend: "c", analysis, parser });
    const nodeCRel = buildNode(file, { outDir: join(dir, "out-c-rel"), mode: "lib", backend: "c", analysis, parser, proved: pr.proved });
    const nodeWasmRel = buildNode(file, { outDir: join(dir, "out-wasm-rel"), mode: "lib", backend: "wasm", analysis, parser, proved: pr.proved });
    const browserRel = buildBrowser(file, { outDir: join(dir, "out-web-rel"), mode: "lib", analysis, parser, proved: pr.proved });

    expect(nodeCDev.diagnostics).toEqual([]);
    expect(nodeCRel.diagnostics).toEqual([]);
    expect(nodeWasmRel.diagnostics).toEqual([]);
    expect(browserRel.diagnostics).toEqual([]);
    expect(nodeCRel.provedEliminated).toBeGreaterThan(0);
    expect(nodeWasmRel.provedEliminated).toBeGreaterThan(0);
    expect(browserRel.provedEliminated).toBeGreaterThan(0);

    for (const outDir of ["out-c-dev", "out-c-rel", "out-wasm-rel"]) {
      const mod = await import(pathToFileURL(join(dir, outDir, "app.js")).href);
      const loaded = await mod.load();
      try {
        const okRes = await loaded.run(loaded.exports.runValid);
        expect(okRes.trap).toBeNull();
        expect(okRes.stdout).toBe("sum=60,min=0\n");

        const idxRes = await loaded.run(loaded.exports.runTrapIdx);
        expect(idxRes.trap?.code).toBe("T002");

        const reqRes = await loaded.run(loaded.exports.runTrapReq);
        expect(reqRes.trap?.code).toBe("T004");
      } finally {
        await loaded.stop();
      }
    }
  });

  it("caches function proofs in .szigyr-cache/prove.json and hydrates overlapping anchors cleanly", async () => {
    const { dir, cacheFile } = makeTmp();
    const src = `
export function overlapAnchor(arr: Ref<Slice<i32>>, k: i64): i32 {
  "use rt";
  requires(arr.length >= 10 && k >= 0 && k < i64(arr.length));
  return arr[usize(k)];
}
`;
    const file = writeTmpFile(dir, "cache.szigyr", src);
    const first = await prove(file, { cacheFile, parser });
    expect(first.diagnostics).toEqual([]);
    expect(first.summary.cached).toBe(0);
    expect(first.summary.failed).toBe(0);
    expect(existsSync(cacheFile)).toBe(true);

    // Second run hits cache and still populates `proved.anchors` distinctly for `T002` + `T003` at `usize(k)`!
    const analysis = analyze(file, parser);
    const second = await prove(file, { analysis, cacheFile, parser });
    expect(second.summary.cached).toBe(1);
    const relC = emitC(analysis.decls!, "native", { proved: second.proved })!.c;
    expect(cFnBody(relC, "overlapAnchor")).not.toContain("sz_chk(");
    expect(cFnBody(relC, "overlapAnchor")).not.toContain("sz_cvti(");

    // Modifying the function invalidates the cache entry
    writeFileSync(file, src.replace("k < i64(arr.length)", "k <= i64(arr.length)"));
    const third = await prove(file, { cacheFile, parser });
    expect(third.summary.cached).toBe(0);
    expect(third.summary.failed).toBe(1);
  });

  it("supports CLI (`prove --json`, `prove --strict`, `build --release`) and MCP (`szigyr_prove`)", async () => {
    const { dir } = makeTmp();
    const file = writeTmpFile(dir, "app.szigyr", `
function safeAdd(a: i32, b: i32): i32 {
  "use rt";
  requires(a >= 0 && a <= 50 && b >= 0 && b <= 50);
  return a + b;
}

export function runStep(xs: Ref<Slice<i32>>): i32 {
  "use rt";
  requires(xs.length >= 1 && xs.length <= 4);
  const bonus: i32 = xs[0] === 0 ? 0 : 1;
  return safeAdd(10, 20) + bonus;
}

export function withUnknown(x: f64): i32 {
  "use rt";
  return i32(x);
}

export function main(sys: System): void {
  const v = Vec.create<i32>(sys.alloc, 2);
  v.push(0);
  v.push(5);
  sys.log.info(\`res=\${runStep(v)}\`);
}
`);
    // CLI `prove --json --no-cache`
    const pJson = await runCli(["prove", "--json", "--no-cache", file]);
    expect(pJson.code).toBe(0);
    const lines = jsonLines(pJson.out);
    const summary = lines.find((l) => l.kind === "prove-summary");
    expect(summary).toBeDefined();
    expect(summary!.failed).toBe(0);
    expect(summary!.unknown).toBeGreaterThan(0);

    // CLI `prove --strict` fails due to `unknown`
    const pStrict = await runCli(["prove", "--no-cache", "--strict", file]);
    expect(pStrict.code).toBe(1);

    // CLI `build --target=node --backend=c --release --json`
    const outDir = join(dir, "dist-rel");
    const bRel = await runCli(["build", "--target=node", "--backend=c", "--release", "--no-cache", "--json", "-o", outDir, file]);
    expect(bRel.code).toBe(0);
    const bJson = JSON.parse(bRel.out.trim());
    expect(bJson.release).toBe(true);
    expect(bJson.provedEliminated).toBeGreaterThan(0);

    // MCP `szigyr_prove` over stdio
    const input = new PassThrough();
    const output = new PassThrough();
    const mcpLines: string[] = [];
    let buf = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        mcpLines.push(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
    });

    const srvDone = serveMcp({ input, output, parser });
    const send = (msg: object) => input.write(`${JSON.stringify(msg)}\n`);
    const nextMsg = async (): Promise<any> => {
      for (let i = 0; i < 200; i++) {
        if (mcpLines.length) return JSON.parse(mcpLines.shift()!);
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error("timed out waiting for MCP reply");
    };

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await nextMsg();
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const listRes = await nextMsg();
    expect(listRes.result.tools.some((t: any) => t.name === "szigyr_prove")).toBe(true);

    send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "szigyr_prove", arguments: { file, noCache: true, strict: false } },
    });
    const proveRes = await nextMsg();
    expect(proveRes.result.structuredContent.ok).toBe(true);
    expect(proveRes.result.structuredContent.functions.length).toBeGreaterThanOrEqual(2);
    expect(proveRes.result.structuredContent.proved).toBeUndefined();

    // Unsound unsaved overlay fails via MCP worker
    send({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "szigyr_prove", arguments: { file, content: `export function oob(s: Ref<Slice<i32>>, i: usize): i32 { "use rt"; return s[i]; }\n` } },
    });
    const badRes = await nextMsg();
    expect(badRes.result.structuredContent.ok).toBe(false);
    expect(badRes.result.structuredContent.summary.failed).toBe(1);

    input.end();
    await srvDone;
  });

  it("proves Arena.alloc/view lengths, struct & Vec return ensures, record params, and tagged-union switch contracts", async () => {
    const { dir, cacheFile } = makeTmp();
    const src = `
type Box = { readonly empty: boolean; readonly x0: usize; readonly x1: usize };
type ToolParams = { readonly radius: usize };
type Tool =
  | { readonly kind: "blur"; readonly params: ToolParams }
  | { readonly kind: "noop"; readonly gain: usize };

const EMPTY: Box = { empty: true, x0: 0, x1: 0 };

function fillBuf(s: Mut<Slice<f32>>, n: usize): void {
  "use rt";
  requires(s.length === n);
  for (let i: usize = 0; i < n; i += 1) s[i] = f32(0);
}

export function useArena(arena: Mut<Arena>, n: usize): boolean {
  "use rt";
  arena.reset();
  const buf = arena.alloc<f32>(n, f32(0));
  if (buf === null) return false;
  fillBuf(arena.view(buf), n);
  return true;
}

function makeBox(w: usize, valid: boolean): Box {
  "use rt";
  requires(w > 0);
  ensures((r: Box) => r.empty || (r.x0 <= r.x1 && r.x1 < w));
  if (!valid) return EMPTY;
  return { empty: false, x0: 0, x1: w - 1 };
}

export function useBox(arr: Ref<Slice<u8>>, w: usize, valid: boolean): u8 {
  "use rt";
  requires(w > 0 && arr.length === w);
  const b = makeBox(w, valid);
  if (b.empty) return 0;
  return arr[b.x1];
}

function checkVecLen(v: Ref<Slice<u8>>, n: usize): u8 {
  "use rt";
  requires(n > 0 && v.length === n);
  return v[n - 1];
}

export function makeVec(alloc: Alloc, n: usize): Vec<u8> {
  "use owned";
  requires(n > 0 && n <= 4096);
  ensures((r: Vec<u8>) => r.length === n);
  const out = Vec.create<u8>(alloc, n);
  for (let i: usize = 0; i < n; i += 1) {
    invariant(out.length === i);
    out.push(0);
  }
  return out;
}

export function useVecEnsures(alloc: Alloc, n: usize): u8 {
  "use owned";
  requires(n > 0 && n <= 4096);
  const v = makeVec(alloc, n);
  return checkVecLen(v, n);
}

function blurPass(radius: usize): usize {
  "use rt";
  requires(radius <= 1024);
  return radius * 2 + 1;
}

export function runTool(tool: Tool): usize {
  "use rt";
  requires(tool.kind !== "blur" || tool.params.radius <= 1024);
  switch (tool.kind) {
    case "blur":
      return blurPass(tool.params.radius);
    case "noop":
      return 0;
  }
}
`;
    const file = writeTmpFile(dir, "real-patterns.szigyr", src);
    const analysis = analyze(file, parser);
    expect(analysis.diagnostics).toEqual([]);

    const res = await prove(file, { analysis, cacheFile, parser });
    expect(res.diagnostics).toEqual([]);
    expect(res.summary).toMatchObject({ failed: 0, unknown: 0, timeout: 0 });

    const relC = emitC(analysis.decls!, "native", { proved: res.proved })!;
    expect(cFnBody(relC.c, "fillBuf")).not.toContain("sz_chk(");
    expect(cFnBody(relC.c, "fillBuf")).not.toContain("sz_trap(4,");
    expect(cFnBody(relC.c, "useBox")).not.toContain("sz_chk(");
    expect(cFnBody(relC.c, "checkVecLen")).not.toContain("sz_chk(");
    expect(cFnBody(relC.c, "checkVecLen")).not.toContain("sz_trap(4,");
    expect(cFnBody(relC.c, "blurPass")).not.toContain("sz_trap(4,");
  });

  it("proves real-app kernels (bench, retouch, audio-portable, audio) with zero failures and eliminates release bounds checks", async () => {
    const repoRoot = join(import.meta.dirname, "../../..");

    const runOne = async (relPath: string) => {
      const file = join(repoRoot, relPath);
      const analysis = analyze(file, parser);
      expect(analysis.diagnostics).toEqual([]);
      const res = await prove(file, { analysis, cache: false, parser });
      expect(res.diagnostics).toEqual([]);
      expect(res.summary.failed).toBe(0);
      expect(res.summary.timeout).toBe(0);
      const relC = emitC(analysis.decls!, "native", { proved: res.proved })!;
      return { res, relC };
    };

    const bench = await runOne("bench/kernels.szigyr");
    expect(bench.relC.eliminated).toBeGreaterThan(0);
    for (const fn of ["dot", "saxpy", "prefix", "stencil", "particles"]) {
      expect(cFnBody(bench.relC.c, fn)).not.toContain("sz_chk(");
    }
    expect(cFnBody(bench.relC.c, "prefix")).toContain("SZ_AOP(add, int32_t");

    const retouch = await runOne("examples/retouch/kernels.szigyr");
    expect(retouch.relC.eliminated).toBeGreaterThan(0);
    for (const fn of [
      "buildGaussianWeights",
      "blurHorizontal",
      "blurVertical",
      "unpackRgbaToRgb",
      "reconstructFrequency",
      "smoothRoiPass",
      "applyBrushStroke",
      "computeImageStats",
    ]) {
      expect(cFnBody(retouch.relC.c, fn)).not.toContain("sz_chk(");
    }
    for (const privFn of ["unpackRgbaToRgb", "reconstructFrequency", "smoothRoiPass"]) {
      expect(cFnBody(retouch.relC.c, privFn)).not.toContain("sz_trap(4,");
    }
    expect(cFnBody(retouch.relC.c, "clampU8")).toContain("sz_cvt(");
    expect(cFnBody(retouch.relC.c, "roiBox")).toContain("sz_trap(5,");

    await runOne("examples/retouch/session.szigyr");

    const audioPortable = await runOne("examples/audio-portable/main.szigyr");
    expect(cFnBody(audioPortable.relC.c, "render")).not.toContain("sz_chk(");
    expect(cFnBody(audioPortable.relC.c, "render")).toContain("sz_trap(4,");

    if (hasSdl3()) {
      const audio = await runOne("examples/audio/main.szigyr");
      expect(cFnBody(audio.relC.c, "fill")).not.toContain("sz_chk(");
      expect(cFnBody(audio.relC.c, "fill")).toContain("sz_trap(4,");
    }
  }, 60_000);

  it("classifies Z3 reason-unknown timeouts cleanly and avoids Wasm stack corruption across repeated queries", async () => {
    const solver = detectSolver();
    const tRes = await runSmtBatch(
      "(declare-const x Int)\n(declare-const y Int)\n(declare-const z Int)",
      [{ assertion: "(= (* x x x) (+ (* y y y) (* z z z) 42))" }],
      { logic: "QF_NIA", timeoutMs: 1 },
    );
    if (solver.kind === "z3" || solver.kind === "z3-wasm") {
      expect(tRes[0]!.status).toBe("timeout");
    } else {
      expect(["timeout", "unknown"]).toContain(tRes[0]!.status);
    }

    for (let i = 0; i < 20; i++) {
      const pad = `; pad ${"x".repeat(i * 97)}`;
      const res = await runSmtBatch(
        `(declare-const x Int)\n${pad}`,
        [{ assertion: "(and (> x -2147483648) (<= x 2147483647) (not (and (>= (- x) -2147483648) (<= (- x) 2147483647))))" }],
        { logic: "QF_LIA", timeoutMs: 2000 },
      );
      expect(res[0]!.status).toBe("unsat");
    }
  });

  it("proves ensures postconditions over Ref/Mut slice lengths while rejecting by-value owned reads and closure capture", async () => {
    const { dir, cacheFile } = makeTmp();
    const okSrc = `
function copyBounded(src: Ref<Slice<u8>>, dst: Mut<Slice<u8>>): usize {
  "use rt";
  ensures((r: usize) => r <= src.length && r <= dst.length);
  const n = src.length < dst.length ? src.length : dst.length;
  for (let i: usize = 0; i < n; i += 1) {
    dst[i] = src[i];
  }
  return n;
}

export function callerUsesEnsures(src: Ref<Slice<u8>>, dst: Mut<Slice<u8>>): u8 {
  "use rt";
  requires(dst.length > 0 && src.length > 0);
  const written = copyBounded(src, dst);
  if (written > 0) {
    return dst[written - 1];
  }
  return 0;
}
`;
    const okFile = writeTmpFile(dir, "borrow-ensures.szigyr", okSrc);
    const analysis = analyze(okFile, parser);
    expect(analysis.diagnostics).toEqual([]);
    const pRes = await prove(okFile, { analysis, cacheFile, parser });
    expect(pRes.diagnostics).toEqual([]);
    expect(pRes.summary.failed).toBe(0);
    expect(pRes.summary.unknown).toBe(0);
    expect(pRes.summary.proved).toBeGreaterThan(0);

    const badFile = writeTmpFile(dir, "bad-borrow-ensures.szigyr", `
function takeVec(v: Vec<u8>): usize {
  "use owned";
  ensures((r: usize) => r <= v.length);
  return v.length;
}
function closureInsideEnsures(s: Ref<Slice<u8>>): usize {
  ensures((r: usize) => ((): boolean => s.length >= r)());
  return s.length;
}
`);
    const badDiags = analyze(badFile, parser).diagnostics.map((d) => `${d.range.start.line}:${d.code}`);
    expect(badDiags).toContain("4:E6002");
    expect(badDiags).toContain("8:E3004");
  });

  it("proves strict Vec.filled length, indexing, and counting loop ensures without manual invariant", async () => {
    const { dir, cacheFile } = makeTmp();
    const src = `
export function rampFilled(alloc: Alloc, n: usize): Vec<f64> {
  "use owned";
  ensures((r) => r.length === n);
  const out = Vec.filled<f64>(alloc, n, 0);
  for (let i: usize = 0; i < n; i += 1) {
    out[i] = f64(i);
  }
  return out;
}

export function directFilledRead(alloc: Alloc, n: usize): u32 {
  "use owned";
  requires(n >= 3);
  const lenOk = Vec.filled<u32>(alloc, n, 7).length;
  if (lenOk !== n) panic("unreachable");
  return Vec.filled<u32>(alloc, 3, 7)[2];
}

export function directFilledLen(alloc: Alloc, n: usize): usize {
  "use owned";
  ensures((r: usize) => r === n);
  return Vec.filled<u32>(alloc, n, 7).length;
}
`;
    const file = writeTmpFile(dir, "vec-filled-prove.szigyr", src);
    const analysis = analyze(file, parser);
    expect(analysis.diagnostics).toEqual([]);
    const pRes = await prove(file, { analysis, cacheFile, parser });
    expect(pRes.diagnostics).toEqual([]);
    expect(pRes.summary.failed).toBe(0);
    expect(pRes.summary.unknown).toBe(0);
    expect(pRes.summary.proved).toBeGreaterThan(0);

    const emitted = emitC(analysis.decls!, "native", { proved: pRes.proved })!;
    expect(cFnBody(emitted.c, "rampFilled")).not.toContain("sz_chk(");
  });

  it("proves unsigned u8/u16/u32 bitwise ops and narrowing while keeping unbounded u32 xor unknown", async () => {
    const { dir, cacheFile } = makeTmp();
    const okSrc = `
export function xorU8Slice(data: Mut<Slice<u8>>, mask: u8): void {
  "use rt";
  for (let i: usize = 0; i < data.length; i += 1) {
    data[i] ^= mask;
  }
}

export function xorWidenedU8(a: u8, b: u8): u8 {
  "use rt";
  return u8(u32(a) ^ u32(b));
}

export function orWidenedU16(a: u16, b: u16): u16 {
  "use rt";
  return u16(u32(a) | u32(b));
}

export function maskedByte(x: u32): u8 {
  "use rt";
  return u8(x & 255);
}
`;
    const okFile = writeTmpFile(dir, "unsigned-bit.szigyr", okSrc);
    const analysis = analyze(okFile, parser);
    expect(analysis.diagnostics).toEqual([]);
    const pRes = await prove(okFile, { analysis, cacheFile, parser });
    expect(pRes.diagnostics).toEqual([]);
    expect(pRes.summary.failed).toBe(0);
    expect(pRes.summary.unknown).toBe(0);
    expect(pRes.summary.proved).toBeGreaterThan(0);

    const badFile = writeTmpFile(dir, "unbounded-xor.szigyr", `
export function badBitNarrow(x: u32): u8 {
  "use rt";
  return u8(x ^ 1);
}
`);
    const badAnalysis = analyze(badFile, parser);
    expect(badAnalysis.diagnostics).toEqual([]);
    const badProve = await prove(badFile, { analysis: badAnalysis, cache: false, parser });
    expect(badProve.summary.failed).toBe(0);
    expect(badProve.summary.unknown).toBe(1);
  });

  it("proves in-range integer literal casts (u32(1), u8(0xff), i32(-4), usize(2)) and deduplicates prove --all across CLI files", async () => {
    const { dir } = makeTmp("szigyr-intlit-");
    const lib = writeTmpFile(dir, "lib.szigyr", `"use owned";
export function maskBit(bit: u8): u8 {
  requires(bit < 8);
  ensures((r: u8) => r <= 255);
  return u8((u32(1) << u32(bit)) & u32(0xff)) ^ u8(0xff);
}
export function offsetNeg(): i32 {
  "use rt";
  ensures((r: i32) => r === -2);
  return i32(-4) + i32(usize(2));
}
`);
    const app = writeTmpFile(dir, "main.szigyr", `import { maskBit, offsetNeg } from "./lib.szigyr";
export function entryFn(b: u8): i32 {
  requires(b < 8);
  return i32(maskBit(b)) + offsetNeg();
}
`);

    const pBoth = await runCli(["prove", "--all", "--strict", "--no-cache", "--json", lib, app]);
    expect(pBoth.code, pBoth.out + pBoth.err).toBe(0);
    const linesBoth = jsonLines(pBoth.out);
    const fnsBoth = linesBoth.filter((l) => l.kind === "prove-fn").map((l) => l.fn).sort();
    expect(fnsBoth).toEqual(["entryFn", "maskBit", "offsetNeg"]);
    expect(linesBoth.find((l) => l.kind === "prove-summary")).toMatchObject({ functions: 3, failed: 0, unknown: 0, timeout: 0 });

    const pRev = await runCli(["prove", "--all", "--strict", "--no-cache", "--json", app, lib]);
    expect(pRev.code, pRev.out + pRev.err).toBe(0);
    expect(jsonLines(pRev.out).find((l) => l.kind === "prove-summary")).toMatchObject({ functions: 3, failed: 0, unknown: 0, timeout: 0 });
  });

  it("proves Struct field loop invariants with bounded havoc and parametric generic rt functions", async () => {
    const { dir, cacheFile } = makeTmp("szigyr-struct-gen-");
    const src = `
type SynthState = Struct<{
  active: boolean;
  history: Vec<f32>;
  histIdx: usize;
}>;

export function renderAudio(st: Mut<SynthState>, out: Mut<Slice<f32>>, frames: usize): void {
  "use rt";
  requires(st.history.length > 0 && st.histIdx < st.history.length);
  const count: usize = frames < out.length ? frames : out.length;
  for (let i: usize = 0; i < count; i += 1) {
    invariant(st.history.length > 0 && st.histIdx < st.history.length);
    const prev = st.history[st.histIdx];
    st.history[st.histIdx] = prev * 0.5;
    st.active = i === 0;
    const nextIdx: usize = st.histIdx + 1;
    st.histIdx = nextIdx === st.history.length ? 0 : nextIdx;
    out[i] = prev;
  }
}

export function pushAllSend<T extends Native & Copy & Send>(tx: Mut<RingTx<T>>, src: Ref<Slice<T>>): usize {
  "use rt";
  let n: usize = 0;
  for (let i: usize = 0; i < src.length; i += 1) {
    invariant(n <= i);
    if (tx.push(src[i])) n += 1;
  }
  return n;
}

export function main(sys: System): void {
  const { tx, rx } = Ring.create<f32>(sys.alloc, 4);
  const v = Vec.filled<f32>(sys.alloc, 2, 1.0);
  sys.log.info(\`\${pushAllSend<f32>(tx, v)}:\${rx.pop() ?? 0}\`);
}
`;
    const file = writeTmpFile(dir, "main.szigyr", src);
    const analysis = analyze(file, parser);
    expect(analysis.diagnostics).toEqual([]);
    const pRes = await prove(file, { analysis, cacheFile, parser });
    expect(pRes.diagnostics).toEqual([]);
    expect(pRes.summary.failed).toBe(0);
    expect(pRes.summary.unknown).toBe(0);
    expect(pRes.summary.timeout).toBe(0);

    const byFn = new Map(pRes.functions.map((f) => [f.fn, f]));
    expect(byFn.get("renderAudio")!.obligations.some((o) => o.kind === "T010" && o.status === "proved")).toBe(true);
    expect(byFn.get("pushAllSend")!.summary).toMatchObject({ failed: 0, unknown: 0, timeout: 0 });

    const relC = emitC(analysis.decls!, "native", { proved: pRes.proved })!;
    expect(cFnBody(relC.c, "renderAudio")).not.toContain("sz_chk(");
    expect(cFnBody(relC.c, "pushAllSend")).not.toContain("sz_chk(");
  });
});

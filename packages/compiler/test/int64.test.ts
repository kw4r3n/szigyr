import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { check, queryFile, run, runTestFile } from "../src/index.ts";
import { mutateFile } from "../src/mutate.ts";

const dir = mkdtempSync(join(tmpdir(), "szigyr-int64-"));
const pkgDir = join(dir, "c64pkg");
execFileSync("mkdir", ["-p", pkgDir]);

writeFileSync(join(pkgDir, "i64ffi.h"), `#ifndef I64FFI_H
#define I64FFI_H
#include <stddef.h>
#include <stdint.h>

#define C64_MIN (-9223372036854775807LL - 1LL)
#define C64_MAX 9223372036854775807LL
#define C64_UMAX 18446744073709551615ULL

extern const int64_t C64_EXT_I64;
extern const uint64_t C64_EXT_U64;

typedef struct Pair64 {
  int64_t s;
  uint64_t u;
} Pair64;

int64_t c64_add(int64_t a, int64_t b);
uint64_t c64_xor(uint64_t a, uint64_t b);
void *c64_alloc(size_t n);
void c64_free(void *p);
int64_t c64_sum_pair(const Pair64 *p);
#endif
`);

writeFileSync(join(pkgDir, "i64ffi.c"), `#include "i64ffi.h"
#include <stdlib.h>
const int64_t C64_EXT_I64 = -9007199254740993LL;
const uint64_t C64_EXT_U64 = 18446744073709551615ULL;
int64_t c64_add(int64_t a, int64_t b) { return a + b; }
uint64_t c64_xor(uint64_t a, uint64_t b) { return a ^ b; }
void *c64_alloc(size_t n) { return calloc(1, n); }
void c64_free(void *p) { free(p); }
int64_t c64_sum_pair(const Pair64 *p) { return p->s + (int64_t)(p->u & 0x7fffffffffffffffULL); }
`);

execFileSync("cc", ["-std=gnu11", "-O2", "-shared", "-fPIC", join(pkgDir, "i64ffi.c"), "-o", join(pkgDir, "libi64ffi.so")]);
writeFileSync(join(pkgDir, "i64ffi.pc"), `prefix=\${pcfiledir}
Name: i64ffi
Description: Szigyr i64/u64 C FFI fixture
Version: 1
Libs: -L\${prefix} -li64ffi -Wl,-rpath,\${prefix}
Cflags: -I\${prefix}
`);

const prevPkgPath = process.env.PKG_CONFIG_PATH;
process.env.PKG_CONFIG_PATH = prevPkgPath ? `${pkgDir}:${prevPkgPath}` : pkgDir;

let seq = 0;
function writeMod(src: string): string {
  const f = join(dir, `t${++seq}.szigyr`);
  writeFileSync(f, src);
  return f;
}

afterAll(() => {
  if (prevPkgPath === undefined) delete process.env.PKG_CONFIG_PATH;
  else process.env.PKG_CONFIG_PATH = prevPkgPath;
  rmSync(dir, { recursive: true, force: true });
});

describe("i64 and u64 support", () => {
  it("typechecks 64-bit literals, operators, and rejects invalid forms", () => {
    const okFile = writeMod(`
export function validLiterals(): i64 {
  "use rt";
  const min: i64 = -9223372036854775808;
  const max: i64 = 9223372036854775807;
  const sci: i64 = 1e18;
  const flt: i64 = 1.0;
  const u: u64 = 0xffff_ffff_ffff_ffff;
  const z: u64 = -0;
  return wrapAdd(min, wrapAdd(max, wrapAdd(sci, wrapAdd(flt, i64(z & u)))));
}
`);
    expect(check(okFile)).toEqual([]);

    const badCases: [string, string][] = [
      ["E2008", `function f(): i64 { const x: i64 = 9223372036854775808; return x; }\n`],
      ["E2008", `function f(): i64 { const x: i64 = -9223372036854775809; return x; }\n`],
      ["E2008", `function f(): i64 { const x: i64 = 1.5; return x; }\n`],
      ["E2008", `function f(): u64 { const x: u64 = 18446744073709551616; return x; }\n`],
      ["E2008", `function f(): u64 { const x: u64 = -1; return x; }\n`],
      ["E2002", `function f(x: u64): u64 { return -x; }\n`],
      ["E2002", `function f(x: u64, y: u64): u64 { return x >> y; }\n`],
      ["E2002", `function f(x: i64, y: i64): i64 { return x >>> y; }\n`],
      ["E2003", `function f(a: i64, b: u64): i64 { return a + b; }\n`],
      ["E2003", `function f(a: i64, b: i32): i64 { return a + b; }\n`],
      ["E2007", `function f(a: i64, b: i64): i64 { return a / b; }\n`],
      ["E1000", `function f(): void { const x = 1n; }\n`],
      ["E1000", `type i64 = { readonly x: i32 };\n`],
      ["E1000", `function u64(): void {}\n`],
    ];
    for (const [want, src] of badCases) {
      const ds = check(writeMod(src));
      expect(ds.some((d) => d.code === want), `${want}: ${JSON.stringify(ds)}`).toBe(true);
    }
  });

  it("matches across js, c, and wasm backends for 64-bit arithmetic, containers, layout, conversions, and traps", async () => {
    const f = writeMod(`
type Packed64 = { readonly tag: u8; readonly lo: i64; readonly hi: u64 };

function readAt1(s: Ref<Slice<i64>>): i64 {
  "use rt";
  return s[1];
}

function sw64(x: i64): i64 {
  "use rt";
  switch (x) {
    case -9223372036854775808: return 100;
    case 9223372036854775807: return 200;
    default: return x;
  }
}

type CoreOut = {
  readonly a: i64; readonly negA: i64; readonly wSum: i64; readonly wSub: i64; readonly wMul: i64;
  readonly d: i64; readonly rm: i64; readonly uBits: u64; readonly sBits: i64;
  readonly swMin: i64; readonly swMax: i64; readonly singleRound: f32;
  readonly vLo: i64; readonly vHi: u64; readonly gotP: u64; readonly av: i64; readonly rv: u64;
};

export function core64(alloc: Alloc, n: i64): CoreOut {
  "use owned";
  let a: i64 = 9007199254740993 + n;
  a += 2;
  a -= 1;
  a *= 2;
  const maxI: i64 = 9223372036854775807;
  const minI: i64 = -9223372036854775808;
  const wSum: i64 = wrapAdd(maxI, 1);
  const wSub: i64 = wrapSub(minI, 1);
  const wMul: i64 = wrapMul(minI, -1);
  const d: i64 = divTrunc(-7, 2);
  const rm: i64 = rem(minI, -1);
  const uMax: u64 = 0xffff_ffff_ffff_ffff;
  const uBits: u64 = (~uMax) | ((u64(1) << 63) >>> 1);
  const sBits: i64 = (minI >> 63) & 15;
  const negA: i64 = -a;
  const singleRound: f32 = f32((u64(1) << 63) + (u64(1) << 39) + 1);
  const v = Vec.create<Packed64>(alloc, 2);
  v.push({ tag: 7, lo: a, hi: uMax });
  const pool = Pool.create<u64>(alloc, 2);
  const h = pool.insert(uMax - 5);
  const gotP: u64 = h !== null ? pool.get(h) : 0;
  const arena = Arena.create(alloc, 128);
  const ab = arena.alloc<i64>(2, minI + 1);
  const av: i64 = ab !== null ? readAt1(arena.view<i64>(ab)) : 0;
  const rp = Ring.create<u64>(alloc, 4);
  rp.tx.push(uBits);
  const rv: u64 = rp.rx.pop() ?? 0;
  return {
    a, negA, wSum, wSub, wMul, d, rm, uBits, sBits,
    swMin: sw64(minI), swMax: sw64(maxI), singleRound,
    vLo: v[0].lo, vHi: v[0].hi, gotP, av, rv,
  };
}

export function trapOvfMul(): i64 { "use rt"; const a: i64 = 4294967296; const b: i64 = 2147483648; return a * b; }
export function trapOvfUMul(): u64 { "use rt"; const a: u64 = 9223372036854775808; const b: u64 = 2; return a * b; }
export function trapOvfNeg(): i64 { "use rt"; const a: i64 = -9223372036854775808; return -a; }
export function trapDivMin(): i64 { "use rt"; const a: i64 = -9223372036854775808; return divTrunc(a, -1); }
export function trapDiv0(): u64 { "use rt"; return divTrunc(u64(5), u64(0)); }
export function trapShift(): u64 { "use rt"; return u64(1) << 64; }
export function trapCvtF64(): i64 { "use rt"; return i64(9223372036854775808.0); }
export function trapCvtU64ToI64(): i64 { "use rt"; const u: u64 = 9223372036854775808; return i64(u); }

export function main(sys: System): void {
  const o = core64(sys.alloc, 1);
  sys.log.info(\`\${o.a}|\${o.negA}|\${o.wSum}|\${o.wSub}|\${o.wMul}|\${o.d}|\${o.rm}|\${o.uBits}|\${o.sBits}|\${o.swMin}|\${o.swMax}|\${o.singleRound}|\${o.vLo}|\${o.vHi}|\${o.gotP}|\${o.av}|\${o.rv}\`);
}
`);
    const q = queryFile(f);
    expect(q.diagnostics).toEqual([]);
    expect(q.symbols.find((s) => s.name === "trapShift")?.rtTrapSites?.some((s) => s.code === "T009")).toBe(true);
    expect(q.symbols.find((s) => s.name === "trapCvtU64ToI64")?.rtTrapSites?.some((s) => s.code === "T003")).toBe(true);

    const outs: string[] = [];
    for (const backend of ["js", "c", "wasm"] as const) {
      const r = await run(f, { backend });
      expect(r.diagnostics, backend).toEqual([]);
      expect(r.trap, backend).toBeNull();
      outs.push(r.stdout.trim());
    }
    expect(outs[0]).toBe(outs[1]);
    expect(outs[1]).toBe(outs[2]);
    expect(outs[0]).toBe(`18014398509481990|-18014398509481990|-9223372036854775808|9223372036854775807|-9223372036854775808|-3|0|4611686018427387904|15|100|200|${Number((1n << 63n) + (1n << 40n))}|18014398509481990|18446744073709551615|18446744073709551610|-9223372036854775807|4611686018427387904`);

    const trapCases: [string, string][] = [
      ["trapOvfMul", "T001"],
      ["trapOvfUMul", "T001"],
      ["trapOvfNeg", "T001"],
      ["trapDivMin", "T001"],
      ["trapDiv0", "T007"],
      ["trapShift", "T009"],
      ["trapCvtF64", "T003"],
      ["trapCvtU64ToI64", "T003"],
    ];
    for (const [fnName, code] of trapCases) {
      const tf = writeMod(`
function step(x: i64): i64 { "use rt"; switch (x) { default: return x; } }
${fnName === "trapOvfMul" ? "function f(): i64 { \"use rt\"; const a: i64 = 4294967296; const b: i64 = 2147483648; return a * b; }" : ""}
${fnName === "trapOvfUMul" ? "function f(): u64 { \"use rt\"; const a: u64 = 9223372036854775808; const b: u64 = 2; return a * b; }" : ""}
${fnName === "trapOvfNeg" ? "function f(): i64 { \"use rt\"; const a: i64 = -9223372036854775808; return -a; }" : ""}
${fnName === "trapDivMin" ? "function f(): i64 { \"use rt\"; const a: i64 = -9223372036854775808; return divTrunc(a, -1); }" : ""}
${fnName === "trapDiv0" ? "function f(): u64 { \"use rt\"; return divTrunc(u64(5), u64(0)); }" : ""}
${fnName === "trapShift" ? "function f(): u64 { \"use rt\"; return u64(1) << 64; }" : ""}
${fnName === "trapCvtF64" ? "function f(): i64 { \"use rt\"; return i64(9223372036854775808.0); }" : ""}
${fnName === "trapCvtU64ToI64" ? "function f(): i64 { \"use rt\"; const u: u64 = 9223372036854775808; return i64(u); }" : ""}
export function main(sys: System): void { sys.log.info(\`\${step(f() as i64)}\`); }
`.replace("f() as i64", "i64(f())"));
      const results = [];
      for (const backend of ["js", "c", "wasm"] as const) {
        const res = await run(tf, { backend });
        expect(res.trap?.code, `${fnName}:${backend}`).toBe(code);
        results.push({ code: res.trap!.code, line: res.trap!.line, col: res.trap!.col });
      }
      expect(results[0], fnName).toEqual(results[1]);
      expect(results[1], fnName).toEqual(results[2]);
    }
  }, 60_000);

  it("supports Map/Set/cast/JSON/t.eq/forAll/mutate/Port with BigInt-safe JSON outputs", async () => {
    const f = writeMod(`
export function addExact(a: i64, b: i64): i64 {
  return wrapAdd(a, b);
}

export function main(sys: System): void {
  const m = new Map<i64, string>();
  const k1: i64 = 9007199254740993;
  m.set(k1, "precise");
  const s = new Set<u64>();
  s.add(18446744073709551615);
  const dec = sys.js.decode<u64>(sys.js.encode<u64>(18446744073709551615));
  const okU64 = dec.kind === "ok" ? \`\${dec.value}\` : "err";
  const decI64 = sys.js.decode<i64>(sys.js.encode<i64>(-9007199254740993));
  const okI64 = decI64.kind === "ok" ? \`\${decI64.value}\` : "err";
  const badU64 = sys.js.decode<u64>(sys.js.encode<i64>(-1));
  sys.log.info(\`\${m.get(k1) ?? "none"}|\${s.has(18446744073709551615)}|\${okU64}|\${okI64}|\${badU64.kind}\`);
}

test("64-bit managed features and forAll", (t: Test) => {
  const a: i64 = 9007199254740993;
  const b: i64 = 9007199254740994;
  t.eq<i64>(wrapAdd(a, 1), b);
  const parsed = JSON.parse("123");
  if (parsed.kind === "ok") {
    t.eq(cast<i64>(parsed.value).kind, "err");
  }
  forAll((x: i64): boolean => wrapSub(wrapAdd(x, 1), 1) === x);
});
`);

    const rJs = await run(f, { backend: "js" });
    expect(rJs.trap).toBeNull();
    expect(rJs.stdout.trim()).toBe("precise|true|18446744073709551615|-9007199254740993|err");

    const badJson = writeMod(`
function encodeCodec<T extends Codec>(x: T): string { return JSON.stringify<T>(x); }
export function f(a: i64, b: u64): void {
  const s1 = JSON.stringify(a);
  const s2 = JSON.stringify<u64>(b);
  const rec: { readonly id: i64 } = { id: a };
  const s3 = JSON.stringify(rec);
  const s4 = encodeCodec<i64>(a);
}
`);
    const badDs = check(badJson);
    expect(badDs.filter((d) => d.code === "E2002" && d.data?.reason === "concrete-type-required").length).toBe(1);
    expect(badDs.filter((d) => d.code === "E2002" && d.data?.reason === "json-int64").length).toBe(3);

    const isoFile = writeMod(`
async function worker(port: Port<Vec<i64>, u64>): Promise<void> {
  const alloc = TestAlloc.create();
  const x = await port.recv();
  if (x !== null) {
    const out = Vec.create<i64>(alloc, 2);
    out.push(i64(x) + 1);
    out.push(-9223372036854775808);
    port.send(out);
  }
}
export async function main(sys: System): Promise<void> {
  const p = sys.spawn.isolate<u64, Vec<i64>>(worker);
  p.send(9007199254740995);
  const ans = await p.recv();
  if (ans !== null) sys.log.info(\`\${ans[0]}|\${ans[1]}\`);
}
`);
    const rIso = await run(isoFile, { backend: "js" });
    expect(rIso.trap).toBeNull();
    expect(rIso.stdout.trim()).toBe("9007199254740996|-9223372036854775808");

    const tr = await runTestFile(f, { backend: "js" });
    expect(tr.results.every((x) => x.ok)).toBe(true);

    // Ensure failing forAll counterexample + mutate witness with i64 are JSON-serializable.
    const failForAll = writeMod(`
test("fail i64", (t: Test) => {
  forAll((x: i64): boolean => x < 9007199254740992);
});
`);
    const trFail = await runTestFile(failForAll, { backend: "js" });
    expect(trFail.results[0]!.ok).toBe(false);
    expect(() => JSON.stringify(trFail.results[0])).not.toThrow();

    const mutFile = writeMod(`
export function f64test(x: i64): i64 {
  return wrapAdd(x, 0);
}
test("dummy", (t: Test) => { t.eq<i64>(f64test(5), 5); });
`);
    const mr = await mutateFile(mutFile, { cache: false });
    expect(mr.diagnostics).toEqual([]);
    expect(mr.mutants.length).toBeGreaterThan(0);
    expect(() => JSON.stringify(mr)).not.toThrow();
  }, 60_000);

  it("supports C FFI functions, consts, and CStruct with int64_t / uint64_t and rejects bad C const ranges", async () => {
    const ffiFile = writeMod(`
declare module "c:i64ffi:i64ffi.h" {
  const C64_MIN: i64;
  const C64_MAX: i64;
  const C64_UMAX: u64;
  const C64_EXT_I64: i64;
  const C64_EXT_U64: u64;
  type Pair64 = CStruct<{ s: i64; u: u64 }>;
  function c64_add(ffi: Ffi, a: i64, b: i64): i64;
  function c64_xor(ffi: Ffi, a: u64, b: u64): u64;
  function c64_alloc(ffi: Ffi, n: usize): Ptr<void>;
  function c64_free(ffi: Ffi, p: Ptr<void>): void;
  function c64_sum_pair(ffi: Ffi, p: ConstPtr<Pair64>): i64;
}
import { C64_MIN, C64_MAX, C64_UMAX, C64_EXT_I64, C64_EXT_U64, Pair64, c64_add, c64_xor, c64_alloc, c64_free, c64_sum_pair } from "c:i64ffi:i64ffi.h";

function freeC64(ffi: Ffi, p: Ptr<void>): void {
  "use owned";
  "use unsafe";
  c64_free(ffi, p);
}

function callFfi(ffi: Ffi): { readonly a: i64; readonly b: u64; readonly sum: i64; readonly sz: usize } {
  "use owned";
  "use unsafe";
  const a: i64 = c64_add(ffi, C64_MAX, C64_MIN);
  const b: u64 = c64_xor(ffi, C64_UMAX, C64_EXT_U64);
  const sz: usize = Ptr.sizeOf<Pair64>();
  using g = Resource.ownWith(c64_alloc(ffi, sz), ffi, freeC64);
  if (g.get().isNull()) panic("oom");
  g.get().cast<Pair64>().write({ s: C64_EXT_I64, u: 42 });
  const sum = c64_sum_pair(ffi, g.get().cast<Pair64>());
  return { a, b, sum, sz };
}

export function main(sys: System): void {
  const o = callFfi(sys.ffi);
  sys.log.info(\`\${o.a}|\${o.b}|\${o.sum}|\${o.sz}\`);
}
`);
    expect(check(ffiFile)).toEqual([]);
    const r = await run(ffiFile, { backend: "c" });
    expect(r.diagnostics).toEqual([]);
    expect(r.trap).toBeNull();
    expect(r.stdout.trim()).toBe("-1|0|-9007199254740951|16");

    const badConst = writeMod(`
declare module "c:i64ffi:i64ffi.h" {
  const C64_UMAX: i64;
  const C64_MIN: u64;
}
import { C64_UMAX, C64_MIN } from "c:i64ffi:i64ffi.h";
export function useC(): i64 { "use rt"; return C64_UMAX + i64(C64_MIN); }
`);
    const ds = check(badConst);
    expect(ds.filter((d) => d.code === "E2009").length).toBe(2);
  }, 60_000);

  it("preserves exact 64-bit integer literals in i64(lit) and u64(lit) casts across js, c, and wasm", async () => {
    const exactFile = writeMod(`
export function exactCasts(): string {
  const a = u64(5558979605539197941);
  const b = u64(18446744073709551615);
  const c = u64(0xffffffffffffffff);
  const d = i64(-9223372036854775808);
  const e = i64(9223372036854775807);
  const f = i64((9007199254740993));
  return \`\${a}|\${b}|\${c}|\${d}|\${e}|\${f}\`;
}
export function rtExact(): u64 {
  "use rt";
  return u64(5558979605539197941);
}
export function main(sys: System): void {
  sys.log.info(\`\${exactCasts()}|\${rtExact()}\`);
}
`);
    expect(check(exactFile)).toEqual([]);
    const outs: string[] = [];
    for (const backend of ["js", "c", "wasm"] as const) {
      const r = await run(exactFile, { backend });
      expect(r.diagnostics, backend).toEqual([]);
      expect(r.trap, backend).toBeNull();
      outs.push(r.stdout.trim());
    }
    expect(outs[0]).toBe("5558979605539197941|18446744073709551615|18446744073709551615|-9223372036854775808|9223372036854775807|9007199254740993|5558979605539197941");
    expect(outs[1]).toBe(outs[0]);
    expect(outs[2]).toBe(outs[0]);

    const trapBodies = [
      `export function main(sys: System): void { const x = u64(-1); sys.log.info(\`\${x}\`); }`,
      `export function main(sys: System): void { const x = i64(9223372036854775808.0); sys.log.info(\`\${x}\`); }`,
      `export function main(sys: System): void { const x = i64(9223372036854775808); sys.log.info(\`\${x}\`); }`,
      `export function main(sys: System): void { const x = u64(1.5); sys.log.info(\`\${x}\`); }`,
    ];
    for (const src of trapBodies) {
      const tf = writeMod(src);
      expect(check(tf)).toEqual([]);
      for (const backend of ["js", "c", "wasm"] as const) {
        const r = await run(tf, { backend });
        expect(r.trap?.code, `${src} (${backend})`).toBe("T003");
      }
    }
  }, 60_000);
});

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main as cliMain } from "../src/cli.ts";
import { emitC } from "../src/emit-c.ts";
import { analyze, CLI_NAME, run, runTestFile } from "../src/index.ts";
import { loadWasm } from "../src/wasm.ts";
import * as rt from "../../runtime-js/src/index.ts";

function tmpFile(name: string, src: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-wasm-test-`));
  const f = join(dir, name);
  writeFileSync(f, src);
  return f;
}

describe("wasm backend", () => {
  it("matches JS and C on traps T001..T013 and restores shadow stack across repeated traps", async () => {
    const f = tmpFile("traps.szigyr", `
type S = OwnedStruct<{ a: i32; b: f64 }>;
type Big = {
  readonly f0: f64; readonly f1: f64; readonly f2: f64; readonly f3: f64;
  readonly f4: f64; readonly f5: f64; readonly f6: f64; readonly f7: f64;
  readonly f8: f64; readonly f9: f64; readonly f10: f64; readonly f11: f64;
  readonly f12: f64; readonly f13: f64; readonly f14: f64; readonly f15: f64;
};
function addI(a: i32, b: i32): i32 { "use rt"; return a + b; }
function getAt(s: Ref<Slice<i32>>, i: usize): i32 { "use rt"; return s[i]; }
function toI8(x: f64): i8 { "use rt"; return i8(x); }
function withReq(x: i32): i32 { "use rt"; requires(x > 0); return x; }
function withEns(x: i32): i32 { "use rt"; ensures((r: i32) => r > 0); return x; }
function doPanic(): void { "use rt"; panic("boom"); }
function doDiv(a: i32, b: i32): i32 { "use rt"; return divTrunc(a, b); }
function doShift(a: i32, n: i32): i32 { "use rt"; return a << n; }
function doInv(n: i32): void {
  "use rt";
  let i: i32 = 0;
  while (i < n) {
    invariant(i < 2);
    i += 1;
  }
}
function badPool(p: Mut<Pool<i32>>, h: Handle<i32>): i32 { "use rt"; return p.get(h); }
function badArena(a: Mut<Arena>, b: ArenaBuf<i32>): i32 { "use rt"; return getAt(a.view(b), 0); }
function ovl(a: Mut<Slice<i32>>, b: Ref<Slice<i32>>): void { "use rt"; a[0] = b[0]; }
function deepFrame(n: usize, x: Big): f64 {
  "use owned";
  if (n === 0) return x.f0;
  const nxt: Big = { ...x, f1: x.f1 + 1 };
  return deepFrame(n + 1, nxt) + x.f2;
}
function mutAndTrap(s: Mut<S>, a: Ref<Vec<i32>>): i32 {
  "use owned";
  s.a = 77;
  s.b = 3.5;
  return a[99];
}
function bigVec(alloc: Alloc): usize {
  "use owned";
  const v = Vec.create<Big>(alloc, 4294967295);
  return v.length;
}

function trapPool(): i32 {
  const p = Pool.create<i32>(TestAlloc.create(), 2);
  const h = p.insert(42);
  if (h !== null) {
    p.remove(h);
    return badPool(p, h);
  }
  return -1;
}
function trapArena(): i32 {
  const ar = Arena.create(TestAlloc.create(), 32);
  const ab = ar.alloc<i32>(2, 9);
  ar.reset();
  if (ab !== null) return badArena(ar, ab);
  return -1;
}
function trapVecIdx(): i32 {
  const v = Vec.create<i32>(TestAlloc.create(), 4);
  return getAt(v, 9);
}
function trapOvl(): void {
  const v = Vec.create<i32>(TestAlloc.create(), 4);
  v.push(1); v.push(2); v.push(3); v.push(4);
  ovl(v.borrowSlice(0, 3), v.borrowSlice(2, 4));
}

test("all traps and repeated deep unwinding", (t: Test) => {
  t.traps("T001", () => { addI(2147483647, 1); });
  t.traps("T002", () => { trapVecIdx(); });
  t.traps("T003", () => { toI8(200); });
  t.traps("T004", () => { withReq(0); });
  t.traps("T005", () => { withEns(-1); });
  t.traps("T006", () => { doPanic(); });
  t.traps("T006", () => { bigVec(TestAlloc.create()); });
  t.traps("T007", () => { doDiv(10, 0); });
  t.traps("T009", () => { doShift(1, 32); });
  t.traps("T010", () => { doInv(5); });
  t.traps("T011", () => { trapPool(); });
  t.traps("T012", () => { trapArena(); });
  t.traps("T013", () => { trapOvl(); });

  const s: S = { a: 1, b: 0.5 };
  const okV = Vec.create<i32>(TestAlloc.create(), 100);
  for (let i: i32 = 0; i < 100; i += 1) okV.push(i);
  t.eq(mutAndTrap(s, okV), 99);
  t.eq(s.a, 77);
  t.eq(s.b, 3.5);

  const big: Big = { f0: 0, f1: 1, f2: 2, f3: 3, f4: 4, f5: 5, f6: 6, f7: 7, f8: 8, f9: 9, f10: 10, f11: 11, f12: 12, f13: 13, f14: 14, f15: 15 };
  for (let i: usize = 0; i < 20; i += 1) {
    t.traps("T006", () => { deepFrame(1, big); });
  }
  t.eq(addI(10, 20), 30);
});
`);
    const rw = await runTestFile(f, { backend: "wasm" });
    expect(rw.diagnostics).toEqual([]);
    expect(rw.results).toEqual([{ name: "all traps and repeated deep unwinding", ok: true }]);
    const rc = await runTestFile(f, { backend: "c" });
    expect(rc.results).toEqual(rw.results);

    // Direct Mut<Struct> write-back on trap verification
    const an = analyze(f);
    expect(an.diagnostics).toEqual([]);
    const ec = emitC(an.decls!, "wasm")!;
    const loaded = await loadWasm(ec.c, ec.meta!, rt.NATIVE_HOST);
    const decl = an.decls!.fns.find((fn) => fn.name === "mutAndTrap")!.decl;
    const key = ec.keys.get(decl)!;
    const s = { a: 1, b: 0.5 };
    const small = rt.Vec.create<number>(undefined, 2, "i32");
    expect(() => loaded.exports[key]!(s, small)).toThrow(/T002/);
    expect(s).toEqual({ a: 77, b: 3.5 });
  });

  it("handles DetMath, Vec growth, Pool, Arena (noteC + cross-type T013), and authority callbacks", async () => {
    const f = tmpFile("features.szigyr", `
type Item = { readonly id: i32; readonly weight: f32; readonly ok: boolean };
function growPush(v: Mut<Vec<Item>>, n: usize): usize {
  "use owned";
  for (let i: usize = 0; i < n; i += 1) {
    v.push({ id: i32(i), weight: f32(i) * f32(0.25), ok: rem(i, 2) === 0 });
  }
  return v.length;
}
function mutSlice0(s: Mut<Slice<i32>>, rnd: Random): void { "use owned"; if (s.length >= 2) { s[0] = i32(rnd.nextU32() & 255); } }
function readF64Gen<T extends Copy & Native>(s: Ref<Slice<T>>): usize { return s.length; }
function readFirst(s: Ref<Slice<f64>>): f64 { "use rt"; return s[0]; }
function fillArena(ar: Mut<Arena>, rnd: Random): ArenaBuf<f64> | null {
  "use owned";
  const b1 = ar.alloc<i32>(2, 11);
  if (b1 === null) return null;
  mutSlice0(ar.view(b1), rnd);
  return ar.alloc<f64>(2, DetMath.sin(0.5) + DetMath.pow(2, 3));
}
function usePool(alloc: Alloc): Vec<i32> {
  "use owned";
  const p = Pool.create<i32>(alloc, 4);
  const h0 = p.insert(100);
  const h1 = p.insert(200);
  if (h0 !== null) { p.remove(h0); }
  const h2 = p.insert(300);
  const out = Vec.create<i32>(alloc, 2);
  if (h1 !== null && h2 !== null) {
    out.push(p.get(h1));
    out.push(p.get(h2));
  }
  return out;
}
function touchF64(s: Mut<Slice<f64>>, r: Ref<Slice<u8>>): f64 { "use rt"; return s[0] + f64(r[0]); }
export function main(sys: System): void {
  const v = Vec.create<Item>(sys.alloc, 1);
  const len = growPush(v, 10);
  sys.log.info(\`len=\${len},last=\${v[9].id},\${v[9].weight},\${v[9].ok}\`);
  const po = usePool(sys.alloc);
  sys.log.info(\`pool=\${po[0]},\${po[1]}\`);
  const ar = Arena.create(sys.alloc, 128);
  const ab = fillArena(ar, SeededRandom.create(42));
  if (ab !== null) {
    sys.log.info(\`arena=\${readF64Gen<f64>(ar.view(ab))},\${readFirst(ar.view(ab))}\`);
  }
}
test("arena reset clears notes and detects byte overlap T013", (t: Test) => {
  const ar = Arena.create(TestAlloc.create(), 128);
  const bf = ar.alloc<f64>(2, 1.5);
  const bu = ar.alloc<u8>(8, 2);
  if (bf !== null && bu !== null) {
    t.eq(touchF64(ar.view(bf), ar.view(bu)), 3.5);
  } else { t.ok(false); }
  ar.reset();
  t.eq(ar.remaining, 128);
});
`);
    const rj = await run(f, { backend: "js" });
    const rc = await run(f, { backend: "c" });
    const rw = await run(f, { backend: "wasm" });
    expect(rw.diagnostics).toEqual([]);
    expect(rw.trap).toBeNull();
    expect(rw.stdout).toBe(rj.stdout);
    expect(rw.stdout).toBe(rc.stdout);

    const tw = await runTestFile(f, { backend: "wasm" });
    expect(tw.results).toEqual([{ name: "arena reset clears notes and detects byte overlap T013", ok: true }]);
  });

  it("runs Ring + spawn.isolate across Workers under --backend=wasm and rejects C-only with E4009", async () => {
    const f = tmpFile("iso.szigyr", `
function workerKernel(rx: Mut<RingRx<i32>>, out: Mut<Vec<i32>>): void {
  "use rt";
  let v = rx.pop();
  while (v !== null) {
    out[0] = out[0] + v * 2;
    v = rx.pop();
  }
}
function workerEntry(port: Port<i32, RingRx<i32>>): Promise<void> {
  return (async () => {
    const rx = await port.recv();
    if (rx !== null) {
      const alloc = TestAlloc.create();
      const acc = Vec.create<i32>(alloc, 1);
      acc.push(0);
      workerKernel(rx, acc);
      port.send(acc[0]);
    }
  })();
}
export function main(sys: System): Promise<void> {
  return (async () => {
    const { tx, rx } = Ring.create<i32>(sys.alloc, 8);
    tx.push(3);
    tx.push(7);
    tx.push(11);
    const port = sys.spawn.isolate<RingRx<i32>, i32>(workerEntry);
    port.send(rx);
    const sum = await port.recv();
    if (sum !== null) { sys.log.info(\`sum=\${sum}\`); }
  })();
}
`);
    const r = await run(f, { backend: "wasm" });
    expect(r.diagnostics).toEqual([]);
    expect(r.trap).toBeNull();
    expect(r.stdout).toBe("sum=42\n");

    const cOnly = tmpFile("conly.szigyr", `
function boxUnbox(alloc: Alloc): i32 { "use owned"; "use unsafe"; const p = Ptr.box<i32>(alloc, 42); return p.unbox(); }
export function main(sys: System): void { sys.log.info(\`\${boxUnbox(sys.alloc)}\`); }
`);
    const re = await run(cOnly, { backend: "wasm" });
    expect(re.diagnostics.map((d) => d.code)).toEqual(["E4009"]);
    expect(re.stdout).toBe("");
  });

  it("supports CLI szigyr run/test --backend=wasm and forAll", async () => {
    const f = tmpFile("cli-wasm.szigyr", `
function addComm(a: i16, b: i16): i32 {
  "use rt";
  return i32(a) + i32(b);
}
test("forAll on rt wasm", (t: Test) => {
  forAll((a: i16, b: i16) => {
    t.eq(addComm(a, b), addComm(b, a));
  });
});
export function main(sys: System): void {
  sys.log.info(\`\${addComm(12, 30)}\`);
}
`);
    let out = "", err = "";
    const c1 = await cliMain(["run", "--backend=wasm", f], (s) => { out += s; }, (s) => { err += s; });
    expect(c1).toBe(0);
    expect(err).toBe("");
    expect(out).toBe("42\n");

    let tout = "", terr = "";
    const c2 = await cliMain(["test", "--json", "--backend=wasm", f], (s) => { tout += s; }, (s) => { terr += s; });
    expect(c2).toBe(0);
    expect(terr).toBe("");
    expect(tout).toContain('"passed":1,"failed":0');
  });
});

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { check, CLI_NAME, type Diagnostic } from "../src/index.ts";

function checkSrc(src: string): Diagnostic[] {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-rs-`));
  const f = join(dir, "main.szigyr");
  writeFileSync(f, src);
  return check(f);
}

const offset = (src: string, p: { line: number; col: number }): number =>
  src.split("\n").slice(0, p.line - 1).reduce((n, l) => n + l.length + 1, 0) + p.col - 1;

function applyFix(src: string, d: Diagnostic): string {
  const edits = [...d.fixes![0]!.edits].sort((a, b) => offset(src, b.range.start) - offset(src, a.range.start));
  let out = src;
  for (const e of edits) {
    out = out.slice(0, offset(src, e.range.start)) + e.newText + out.slice(offset(src, e.range.end));
  }
  return out;
}

describe("P1 -> P2 recovery without crashing", () => {
  const recoveryCases: [string, string][] = [
    ["interface mixing property and method signatures", "interface Point { x: f64; m(): void; }\n"],
    ["interface with index signature", "interface Dict { [k: string]: i32; }\n"],
    ["type literal with index signature", "type Dict = { [k: string]: i32 };\n"],
    ["type literal with method signature", "type HasMethod = { foo(): i32; readonly x: i32 };\n"],
    ["function overload without body", "function ov(x: i32): i32;\nfunction ov(x: i32): i32 { return x; }\n"],
    ["anonymous default function export", "export default function(): void {}\n"],
    ["anonymous default class export", "export default class {}\n"],
    ["module const without initializer", "const x: i32;\n"],
    ["class with computed property name", 'class C { ["a"]: i32 = 1; }\n'],
    ["class method overload without body", "class C { foo(x: i32): void; }\n"],
    ["class constructor overload without body", "class C { constructor(x: i32); }\n"],
    ["numeric and boolean literal types", "type One = 1;\ntype Flag = true;\n"],
    ["type literal with computed property name", 'type Comp = { readonly ["a"]: i32; readonly b: i32 };\n'],
    ["c: module type alias without type literal", 'declare module "c:m" {\n  type Bad = i32;\n}\n'],
    ["for-of without const/let", "function f(xs: Array<i32>): void {\n  let x: i32 = 0;\n  for (x of xs) {}\n}\n"],
  ];

  it.each(recoveryCases)("%s", (_name, src) => {
    const ds = checkSrc(src);
    expect(ds.length).toBeGreaterThan(0);
    expect(ds.some((d) => d.code.startsWith("E"))).toBe(true);
  });
});

describe("Fake types in type annotations", () => {
  it("accepts FakeClock, SeededRandom, MemoryLog, FakeFs, FakeSpawn, FakeAudio, FakeNet, FakeProc in params, returns, locals, fields, and assigns to authorities", () => {
    const ds = checkSrc(`
type Fakes = {
  readonly clock: FakeClock;
  readonly rng: SeededRandom;
  readonly log: MemoryLog;
  readonly fs: FakeFs;
  readonly spawn: FakeSpawn;
  readonly audio: FakeAudio;
  readonly display: FakeDisplay;
  readonly net: FakeNet;
  readonly proc: FakeProc;
};

function takeClock(c: Clock): f64 { return c.nowMs(); }
function takeRandom(r: Random): f64 { return r.nextF64(); }
function takeLog(l: Log): void { l.info("ok"); }
function takeFs(f: Fs): void { const _r = f.readText("a"); }
function takeSpawn(s: Spawn): void {}
function takeAudio(a: Audio): void {}
function takeDisplay(d: Display): void {}
function takeNet(n: Net): void {}
function takeProc(p: Proc): string { return p.cwd(); }

function makeClock(): FakeClock { return FakeClock.create(0); }
function makeRandom(): SeededRandom { return SeededRandom.create(1); }
function makeLog(): MemoryLog { return MemoryLog.create(); }
function makeFs(): FakeFs { return FakeFs.create(); }
function makeSpawn(): FakeSpawn { return FakeSpawn.create(); }
function makeAudio(): FakeAudio { return FakeAudio.create(); }
function makeDisplay(): FakeDisplay { return FakeDisplay.create(); }
function makeNet(): FakeNet { return FakeNet.create(); }
function makeProc(): FakeProc { return FakeProc.create(); }

export function useAll(f: Fakes): f64 {
  const c: FakeClock = makeClock();
  const r: SeededRandom = makeRandom();
  const l: MemoryLog = makeLog();
  const fs: FakeFs = makeFs();
  const sp: FakeSpawn = makeSpawn();
  const au: FakeAudio = makeAudio();
  const dp: FakeDisplay = makeDisplay();
  const nt: FakeNet = makeNet();
  const pr: FakeProc = makeProc();
  takeClock(c);
  takeClock(f.clock);
  takeRandom(r);
  takeRandom(f.rng);
  takeLog(l);
  takeLog(f.log);
  takeFs(fs);
  takeFs(f.fs);
  takeSpawn(sp);
  takeSpawn(f.spawn);
  takeAudio(au);
  takeAudio(f.audio);
  takeDisplay(dp);
  takeDisplay(f.display);
  takeNet(nt);
  takeNet(f.net);
  takeProc(pr);
  takeProc(f.proc);
  return c.nowMs() + r.nextF64();
}
`);
    expect(ds).toEqual([]);
  });
});

describe("borrowOk soundness (isOwnedCap)", () => {
  it("rejects Ref/Mut of readonly Struct with T extends Native (E2002)", () => {
    const dsRef = checkSrc(`
function bad<T extends Native>(r: Ref<Struct<{ readonly x: T }>>): void {
  "use owned";
}
`);
    expect(dsRef.map((d) => d.code)).toContain("E2002");

    const dsMut = checkSrc(`
function bad<T extends Native>(r: Mut<Struct<{ readonly x: T }>>): void {
  "use owned";
}
`);
    expect(dsMut.map((d) => d.code)).toContain("E2002");
  });

  it("accepts Ref/Mut of readonly Struct with T extends Owned and mutable Struct with T extends Native", () => {
    const ds = checkSrc(`
function okOwned<T extends Owned>(r: Ref<Struct<{ readonly x: T }>>): void {
  "use owned";
}
function okMutField<T extends Native>(r: Ref<Struct<{ x: T }>>, m: Mut<Struct<{ x: T }>>): void {
  "use owned";
}
`);
    expect(ds).toEqual([]);
  });
});

describe("authorityFix with System or existing authority parameter", () => {
  it("rewrites console/Date/performance/Math.random in main(sys: System) with a single edit and no param mutation", () => {
    const cases: [string, string, string][] = [
      ['export function main(sys: System): void {\n  console.log("hi");\n}\n', "sys.log.info", "use 'sys.log'"],
      ['export function main(sys: System): void {\n  console.warn("hi");\n}\n', "sys.log.warn", "use 'sys.log'"],
      ['export function main(sys: System): void {\n  console.error("hi");\n}\n', "sys.log.error", "use 'sys.log'"],
      ["export function main(sys: System): f64 {\n  return Date.now();\n}\n", "sys.clock.nowMs", "use 'sys.clock'"],
      ["export function main(sys: System): f64 {\n  return performance.now();\n}\n", "sys.clock.nowMs", "use 'sys.clock'"],
      ["export function main(sys: System): f64 {\n  return Math.random();\n}\n", "sys.random.nextF64", "use 'sys.random'"],
    ];

    for (const [src, replacement, expectedTitle] of cases) {
      const ds = checkSrc(src);
      expect(ds).toHaveLength(1);
      const d = ds[0]!;
      expect(d.code).toBe("E5001");
      expect(d.fixes).toHaveLength(1);
      expect(d.fixes![0]!.title).toBe(expectedTitle);
      expect(d.fixes![0]!.edits).toHaveLength(1);
      expect(d.fixes![0]!.edits[0]!.newText).toBe(replacement);
      const fixed = applyFix(src, d);
      expect(fixed).toContain("main(sys: System)");
      expect(checkSrc(fixed)).toEqual([]);
    }
  });

  it("reuses an existing authority parameter under any name without adding a duplicate parameter", () => {
    const src = 'export function f(logger: Log): void {\n  console.log("hi");\n}\n';
    const ds = checkSrc(src);
    expect(ds).toHaveLength(1);
    const d = ds[0]!;
    expect(d.code).toBe("E5001");
    expect(d.fixes).toHaveLength(1);
    expect(d.fixes![0]!.edits).toHaveLength(1);
    expect(d.fixes![0]!.edits[0]!.newText).toBe("logger.info");
    const fixed = applyFix(src, d);
    expect(fixed).toContain("f(logger: Log)");
    expect(checkSrc(fixed)).toEqual([]);
  });
});

describe("clean user-facing diagnostic messages", () => {
  it("contains no internal Qxxx or section (§) references", () => {
    const ds = checkSrc(`
function cross(s: string): void { "use owned"; }
function rtGen<T>(x: i32): void { "use rt"; }
function badInst(): void { rtGen<Alloc>(1); }
function mInst<T>(x: i32): void {}
function sCaller(): void { "use owned"; mInst<i32>(1); }
function badPort(p: Port<string, i32>): void {}
function badArr(xs: Array<Vec<i32>>): void {}
`);
    expect(ds.length).toBeGreaterThan(0);
    for (const d of ds) {
      expect(d.message).not.toMatch(/Q\d+/);
      expect(d.message).not.toContain("§");
      expect(d.message).not.toContain("SPEC");
    }
  });
});

describe("strict generic Native equivalence", () => {
  it("rejects wrap(sys.alloc) returning Struct<{ readonly a: T }> with E4002 (requiredCap: Native)", () => {
    const ds = checkSrc(`
function wrap<T>(x: T): Struct<{ readonly a: T }> { "use owned"; return { a: x }; }
export function main(sys: System): void {
  const _w = wrap(sys.alloc);
}
`);
    expect(ds.map((d) => d.code)).toContain("E4002");
    expect(ds.find((d) => d.code === "E4002")?.data).toMatchObject({ requiredCap: "Native" });
  });

  it("allows forwarding strict T to rtId<T>, passes with i32, and rejects strictWrap<Alloc> with E4002", () => {
    const okDs = checkSrc(`
function rtId<T>(x: T): T { "use rt"; return x; }
function strictWrap<T>(x: T): T { "use owned"; return rtId<T>(x); }
export function main(): i32 {
  return strictWrap<i32>(42);
}
`);
    expect(okDs).toEqual([]);

    const badDs = checkSrc(`
function rtId<T>(x: T): T { "use rt"; return x; }
function strictWrap<T>(x: T): T { "use owned"; return rtId<T>(x); }
export function main(sys: System): void {
  const _a = strictWrap<Alloc>(sys.alloc);
}
`);
    expect(badDs.map((d) => d.code)).toEqual(["E4002"]);
    expect(badDs[0]?.data).toMatchObject({ requiredCap: "Native" });
  });

  it("still rejects rt generic rtId<Alloc>(sys.alloc) with E4006", () => {
    const ds = checkSrc(`
function rtId<T>(x: T): T { "use rt"; return x; }
export function main(sys: System): void {
  const _a = rtId<Alloc>(sys.alloc);
}
`);
    expect(ds.map((d) => d.code)).toEqual(["E4006"]);
  });
});

describe("audit soundness, inference, and comparable fixes", () => {
  it("invalidates narrowing when an arrow default-parameter initializer mutates a captured local", () => {
    const ds = checkSrc(`
export function f(): i32 {
  let x: i32 | null = 10;
  const inner = (a: i32 = ((): i32 => { x = null; return 0; })()): i32 => a;
  if (x !== null) {
    const _z = inner();
    return x + 1;
  }
  return 0;
}
`);
    expect(ds.map((d) => d.code)).toContain("E2002");
  });

  it("enforces contract purity (E6002) in invariant(...) while allowing loop locals", () => {
    const okDs = checkSrc(`
export function good(v: Ref<Vec<i32>>): usize {
  let i: usize = 0;
  while (i < v.length) {
    invariant(i >= 0 && i <= v.length);
    i = i + 1;
  }
  return i;
}
`);
    expect(okDs).toEqual([]);

    const badDs = checkSrc(`
function nextRand(r: Random): u32 { return r.nextU32(); }
export function bad(r: Random): i32 {
  let i: i32 = 0;
  while (i < 2) {
    invariant(nextRand(r) >= 0);
    i = i + 1;
  }
  return i;
}
`);
    expect(badDs.map((d) => d.code)).toEqual(["E6002"]);
  });

  it("infers T from Ptr<U> passed to ConstPtr<T> while rejecting t.eq on Port, Ptr, and CHandle", () => {
    const okDs = checkSrc(`
declare module "c:m:stdio.h" {
  type Opaque = CStruct<{ readonly x: i32 }>;
}
import type { Opaque } from "c:m:stdio.h";
function peek<T extends Native & Copy>(p: ConstPtr<T>): boolean {
  "use owned";
  "use unsafe";
  return p.isNull();
}
function callPeek(): boolean {
  "use owned";
  "use unsafe";
  const p: Ptr<i32> = Ptr.null<i32>();
  return peek(p);
}
function badEq(p1: Ptr<i32>, p2: Ptr<i32>, c1: CHandle<Opaque>, c2: CHandle<Opaque>, t: Test): void {
  t.eq(p1, p2);
  t.eq(c1, c2);
}
function worker(port: Port<i32, i32>): void { port.close(); }
test("port eq", (t: Test) => {
  const sp = FakeSpawn.create();
  const p1 = sp.isolate(worker);
  const p2 = sp.isolate(worker);
  t.eq(p1, p2);
});
`);
    const e2002 = okDs.filter((d) => d.code === "E2002");
    expect(e2002).toHaveLength(3);
    expect(okDs.some((d) => d.code === "E2006")).toBe(false);
  });

  it("rejects partial destructuring of owned Struct when any owned field is omitted while allowing Copy omissions", () => {
    const twoOwned = checkSrc(`
type Pair = Struct<{ a: Vec<i32>; b: Vec<i32> }>;
function f(alloc: Alloc): usize {
  "use owned";
  const s: Pair = { a: Vec.create<i32>(alloc, 1), b: Vec.create<i32>(alloc, 2) };
  const { a } = s;
  return a.length;
}
`);
    expect(twoOwned.map((d) => d.code)).toEqual(["E3003"]);
    expect(twoOwned[0]?.data).toEqual({ field: "b", fields: ["b"] });

    const onlyCopy = checkSrc(`
type Meta = Struct<{ id: i32; a: Vec<i32> }>;
function f(alloc: Alloc): i32 {
  "use owned";
  const s: Meta = { id: 7, a: Vec.create<i32>(alloc, 1) };
  const { id } = s;
  return id;
}
`);
    expect(onlyCopy.map((d) => d.code)).toEqual(["E3003"]);

    const rvalueRing = checkSrc(`
function f(alloc: Alloc): boolean {
  "use owned";
  const { tx } = Ring.create<i32>(alloc, 4);
  return tx.push(1);
}
`);
    expect(rvalueRing.map((d) => d.code)).toEqual(["E3003"]);

    const omitCopyOk = checkSrc(`
type Meta = Struct<{ a: Vec<i32>; id: i32 }>;
function okUse(alloc: Alloc): usize {
  "use owned";
  const s: Meta = { a: Vec.create<i32>(alloc, 1), id: 7 };
  const { a } = s;
  return a.length;
}
`);
    expect(omitCopyOk).toEqual([]);

    const useAfterOmit = checkSrc(`
type Meta = Struct<{ a: Vec<i32>; id: i32 }>;
function badReuse(alloc: Alloc): i32 {
  "use owned";
  const s: Meta = { a: Vec.create<i32>(alloc, 1), id: 7 };
  const { a } = s;
  return s.id;
}
`);
    expect(useAfterOmit.map((d) => d.code)).toEqual(["E3001"]);

    const borrowReadCopyOk = checkSrc(`
type Meta = Struct<{ a: Vec<i32>; id: i32 }>;
function peekId(s: Ref<Meta>): i32 {
  "use owned";
  const { id } = s;
  return id;
}
`);
    expect(borrowReadCopyOk).toEqual([]);

    const borrowMoveErr = checkSrc(`
type Pair = Struct<{ a: Vec<i32>; b: Vec<i32> }>;
function badBorrow(s: Ref<Pair>): usize {
  "use owned";
  const { a } = s;
  return a.length;
}
`);
    expect(borrowMoveErr.map((d) => d.code)).toEqual(["E3004"]);
  });
});

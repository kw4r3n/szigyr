// P2 behaviour that the conformance corpus does not pin (D009 - D012).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { check, CLI_NAME, deterministicFunctions, rtTrapSites } from "../src/index.ts";

/** Writes the files to a fresh directory and checks `main.szigyr`. */
function run(files: Record<string, string>): string[] {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-`));
  for (const [n, src] of Object.entries(files)) writeFileSync(join(dir, n), src);
  return check(join(dir, "main.szigyr")).map((d) => `${d.code} ${d.file.split("/").pop()} ${d.range.start.line}:${d.range.start.col}`).sort();
}

it("importing a name the module does not export is E7001 at the name, and P2 recovers across the rest of the file", () => {
  const got = run({
    "main.szigyr": 'import { a, b as c } from "./a.szigyr";\nfunction f(): f64 { return nope; }\n',
    "a.szigyr": "export function a(): void {}\nfunction b(): void {}\n",
  });
  expect(got).toEqual(["E2000 main.szigyr 2:28", "E7001 main.szigyr 1:13"]);
});

it("all-phase recovery reports P1, P2, and P3 diagnostics together without <error> cascades", () => {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-`));
  writeFileSync(join(dir, "main.szigyr"), `function p1(x: i32): f64 {
  return x as f64;
}
function p2(x: i32, y: f64): f64 {
  return x + y;
}
function p3(alloc: Alloc): Vec<i32> {
  "use owned";
  const v = Vec.create<i32>(alloc, 1);
  const w = v;
  return v;
}
`);
  const ds = check(join(dir, "main.szigyr"));
  expect(ds.map((d) => d.code).sort()).toEqual(["E1005", "E2003", "E3001"]);
  expect(ds.every((d) => !d.message.includes("<error>"))).toBe(true);
});

it("exported aliases resolve across files", () => {
  expect(run({
    "main.szigyr": 'import { two as dos, P } from "./a.szigyr";\nexport function f(p: P): f64 { return p.x + dos(); }\n',
    "a.szigyr": "function two(): f64 { return 2; }\nexport type P = { readonly x: f64 };\nexport { two };\n",
  })).toEqual([]);
});

it("readonly behind a type alias is checked in P2 (Q072)", () => {
  expect(run({ "main.szigyr": "type P = { x: i32 };\nconst O: P = { x: 1 };\n" })).toEqual(["E5002 main.szigyr 2:14"]);
  expect(run({ "main.szigyr": "type P = { readonly x: i32 };\nconst O: P = { x: 1 };\n" })).toEqual([]);
  expect(run({ "main.szigyr": "type A = Array<i32>;\nconst O: A = [1];\n" })).toEqual(["E5002 main.szigyr 2:14"]);
});

it("E5001 for a global authority carries a fix that takes the authority as a parameter (Q073)", () => {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-`));
  writeFileSync(join(dir, "main.szigyr"), 'function s(n: i32): void {\n  console.log("hi");\n}\n');
  const [d] = check(join(dir, "main.szigyr"));
  expect(d?.code).toBe("E5001");
  expect(d?.data).toEqual({ name: "console", authority: "Log" });
  expect(d?.fixes?.[0]?.edits).toEqual([
    { range: { start: { line: 1, col: 18 }, end: { line: 1, col: 18 } }, newText: ", log: Log" },
    { range: { start: { line: 2, col: 3 }, end: { line: 2, col: 14 } }, newText: "log.info" },
  ]);
  writeFileSync(join(dir, "main.szigyr"), 'function s(): void {\n  console.log("hi");\n}\n');
  expect(check(join(dir, "main.szigyr"))[0]?.fixes?.[0]?.edits).toEqual([
    { range: { start: { line: 1, col: 12 }, end: { line: 1, col: 12 } }, newText: "log: Log" },
    { range: { start: { line: 2, col: 3 }, end: { line: 2, col: 14 } }, newText: "log.info" },
  ]);
});

it("answers which functions are deterministic (§7.3, Q062)", () => {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-`));
  writeFileSync(join(dir, "main.szigyr"), [
    "type Env = { readonly log: Log };",
    "interface I { m(): i32; }",
    "function pure(x: i32, xs: Array<string>): i32 { return x; }",
    "function viaRecord(e: Env): void {}",
    "function viaFn(f: (x: i32) => i32): void {}",
    "function viaIface(i: I): void {}",
    "function viaUnknown(u: unknown | null): void {}",
    "function viaJs(r: Result<JsRef, string>): void {}",
    "",
  ].join("\n"));
  expect(deterministicFunctions(join(dir, "main.szigyr"))).toEqual({
    pure: true, viaRecord: false, viaFn: false, viaIface: false, viaUnknown: false, viaJs: false,
  });
});

// Forms: [name, source, expected sorted "code line:col" list]
const forms: [string, string, string[]][] = [
  ["const reassignment", "function f(): void { const x = 1; x = 2; }", ["E2002 1:35"]],
  ["readonly record field", "type P = { readonly x: f64 };\nfunction f(p: P): void { p.x = 1; }", ["E2002 2:28"]],
  ["private member outside the class", "class A { private n: i32 = 0; }\nfunction f(a: A): i32 { return a.n; }", ["E2002 2:34"]],
  ["argument count", "function g(a: i32): i32 { return a; }\nfunction f(): i32 { return g(1, 2); }", ["E2002 2:28"]],
  ["nullable without narrowing", "function f(x: f64 | null): f64 { return x + 1; }", ["E2002 1:43"]],
  ["narrowing by early return", "function f(x: f64 | null): f64 { if (x === null) { return 0; } return x + 1; }", []],
  ["narrowing by kind", "type S = { readonly kind: \"a\"; readonly x: f64 } | { readonly kind: \"b\"; readonly y: f64 };\nfunction f(s: S): f64 { if (s.kind === \"a\") { return s.x; } return s.y; }", []],
  ["ReadonlyArray has no push (Q032)", "function f(xs: ReadonlyArray<i32>): void { xs.push(1); }", ["E2001 1:47"]],
  ["generic class inferred from the constructor", "class B<T> { readonly v: T; constructor(v: T) { this.v = v; } get(): T { return this.v; } }\nfunction f(x: i32): i32 { return new B(x).get(); }", []], // Q068 (b): managed T is never owned
  ["implements with a different signature", "interface I { m(): i32; }\nclass A implements I { m(): f64 { return 1; } }", ["E2002 2:20"]],
  ["while (true) with break reaches the end (Q023)", "function f(b: boolean): i32 { while (true) { if (b) { break; } } }", ["E2002 1:10"]],
  ["strict calls a managed-only Math function (Q044)", "function f(x: f64): f64 { \"use owned\"; return Math.sin(x); }", ["E4001 1:52"]],
  ["strict calls rt", "function r(): void { \"use rt\"; }\nfunction f(): void { \"use owned\"; r(); }", []],
  ["keys() only in for-of (Q032)", "function f(m: Map<string, i32>): void { const k = m.keys(); }", ["E2002 1:51"]],
  ["class privacy does not leak into a later test body", "class A { private n: i32 = 0; }\ntest(\"x\", (t: Test) => { t.eq(new A().n, 0); });", ["E2002 2:39"]],
  ["a type argument must satisfy its constraint (§3.2)", "interface S { score(): f64; }\nfunction tot<T extends S>(xs: ReadonlyArray<T>): f64 { return 0; }\nfunction f(xs: Array<f64>): f64 { return tot(xs); }", ["E2002 3:42"]],
  ["inference through Result", "function isOk<T>(r: Result<T, string>): boolean { return r.kind === \"ok\"; }\nfunction f(r: Result<i32, string>): boolean { return isOk(r); }", []],
  ["generic arrow function", "function f(): i32 { const id = <T>(x: T): T => x; return id<i32>(1); }", []],
  ["E5001 fix in a function without parameters (Q073)", "function s(): void { console.log(\"hi\"); }", ["E5001 1:22"]],
  ["void callback with an expression body (Q074)", "function f(xs: Array<i32>, out: Array<i32>): void { xs.forEach((x: i32) => out.push(x)); }", []],
];

it.each(forms)("%s", (_name, src, want) => {
  expect(run({ "main.szigyr": src + "\n" }).map((s) => s.replace(" main.szigyr", ""))).toEqual(want);
});

it("the D050 fallback stays silent when a signature already reported", () => {
  expect(run({ "main.szigyr": "function f(x: Nope): i32 { return x.y; }\n" })).toEqual(["E2000 main.szigyr 1:15"]);
  expect(run({ "main.szigyr": "type A = Array<A>;\nfunction g(a: A): string { return a[0]; }\n" }).filter((d) => d.startsWith("E2002")).length).toBe(1);
});

it("one diagnostic per code and position (Q133)", () => {
  expect(run({ "main.szigyr": "async function g(): Promise<void> {}\nfunction f(): void { const a = [g()]; }\n" })).toEqual(["E2002 main.szigyr 2:33"]);
});

it("lists the trap sites of rt functions (§6)", () => {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-`));
  writeFileSync(join(dir, "main.szigyr"), [
    "function k(v: Mut<Slice<i32>>, n: i32): i32 {",
    '  "use rt";',
    "  requires(n > 0);",
    "  v[0] = divTrunc(n, 2) + i32(f64(n) * 0.5);",
    "  n += 1;",
    "  return -n << 1;",
    "}",
    "function m(x: f64): f64 { return x + 1; }",
    "",
  ].join("\n"));
  const at = (code: string, line: number, col: number): { code: string; line: number; col: number } => ({ code, line, col });
  expect(rtTrapSites(join(dir, "main.szigyr"))).toEqual({
    k: [at("T004", 3, 3), at("T002", 4, 5), at("T001", 4, 10), at("T007", 4, 10), at("T001", 4, 25), at("T003", 4, 27), at("T001", 5, 5), at("T001", 6, 10), at("T009", 6, 13)],
  });
});

it("lists T015 at the member name of Ptr / ConstPtr operations in rt + unsafe functions (§6, §14.4)", () => {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-t015-`));
  writeFileSync(join(dir, "main.szigyr"), [
    "function z(s: Mut<Slice<i32>>): void {",
    '  "use rt";',
    "  s.fill(0);",
    "}",
    "function pw(p: Ptr<i32>, q: ConstPtr<i32>): i32 {",
    '  "use rt";',
    '  "use unsafe";',
    "  p.write(q.read());",
    "  z(p.offset(1).slice(2));",
    "  return p.isNull() ? 0 : 1;",
    "}",
    "",
  ].join("\n"));
  const at = (code: string, line: number, col: number): { code: string; line: number; col: number } => ({ code, line, col });
  expect(rtTrapSites(join(dir, "main.szigyr"))).toEqual({
    z: [],
    pw: [at("T015", 8, 5), at("T015", 8, 13), at("T015", 9, 7), at("T015", 9, 17)],
  });
});

it("slices of two different Struct fields are no T013 site, two slices of one field are (Q190, Q239)", () => {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-t013-`));
  writeFileSync(join(dir, "main.szigyr"), [
    "type P = Struct<{ a: Vec<i32>; b: Vec<i32> }>;",
    "function copy(d: Mut<Slice<i32>>, s: Ref<Slice<i32>>): void {",
    '  "use rt";',
    "  d[0] = s[0];",
    "}",
    "function two(p: Mut<P>): void {",
    '  "use rt";',
    "  copy(p.a.slice(0, 1), p.b.slice(0, 1));",
    "  copy(p.a.slice(0, 1), p.a.slice(1, 2));",
    "  copy(p.a.slice(0, 1), (p.a).slice(1, 2));",
    "}",
    "",
  ].join("\n"));
  const t013 = rtTrapSites(join(dir, "main.szigyr")).two!.filter((s) => s.code === "T013");
  expect(t013).toEqual([{ code: "T013", line: 9, col: 29 }, { code: "T013", line: 10, col: 31 }]);
});

it("determinism checks generic class type arguments across parameters (§7.3)", () => {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-det-`));
  writeFileSync(join(dir, "main.szigyr"), [
    "class Box<T> { readonly v: T; constructor(v: T) { this.v = v; } }",
    "export function leak(a: Box<i32>, b: Box<Clock>): f64 { return b.v.nowMs(); }",
    "export function leak2(b: Box<Clock>, a: Box<i32>): f64 { return b.v.nowMs(); }",
    "export function pure(a: Box<i32>, b: Box<i32>): i32 { return a.v + b.v; }",
    "",
  ].join("\n"));
  expect(deterministicFunctions(join(dir, "main.szigyr"))).toEqual({ leak: false, leak2: false, pure: true });
});

it("lists only T007 for rem and T003 for usize-returning C calls (§3, §14.2)", () => {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-traps-`));
  writeFileSync(join(dir, "main.szigyr"), [
    'declare module "c:zlib:zlib.h" {',
    "  function compressBound(ffi: Ffi, sourceLen: usize): usize;",
    "}",
    'import { compressBound } from "c:zlib:zlib.h";',
    "function r(a: i32, b: i32): i32 {",
    '  "use rt";',
    "  return rem(a, b);",
    "}",
    "function cb(n: usize): usize {",
    '  "use rt";',
    '  "use unsafe";',
    "  return compressBound(n);",
    "}",
    "",
  ].join("\n"));
  const at = (code: string, line: number, col: number): { code: string; line: number; col: number } => ({ code, line, col });
  expect(rtTrapSites(join(dir, "main.szigyr"))).toEqual({
    r: [at("T007", 7, 10)],
    cb: [at("T003", 12, 10)],
  });
});

it("enforces explicit capability bounds and intersection constraints (SPEC-v1 §3.4)", () => {
  expect(run({
    "main.szigyr": [
      "function dup<T extends Copy>(x: T): T { return x; }",
      "function passOk(): void {",
      '  dup<string>("hi");',
      '  dup<{ readonly s: string }>({ s: "a" });',
      "}",
      "function bad(a: Alloc): void {",
      "  dup<Vec<i32>>(Vec.create<i32>(a, 1));",
      "  dup<Array<i32>>([1]);",
      "}",
      "",
    ].join("\n"),
  })).toEqual(["E2002 main.szigyr 7:7", "E2002 main.szigyr 8:7"]);

  expect(run({
    "main.szigyr": [
      "function mkBad<T extends Copy>(a: Alloc, x: T): Vec<T> { return Vec.create<T>(a, 1); }",
      "function mkOk<T extends Copy & Native>(a: Alloc, x: T): Vec<T> { return Vec.create<T>(a, 1); }",
      "function wrapStrict<T>(x: T): T { \"use owned\"; return x; }",
      "function fromManaged<T extends Copy>(x: T): T { return wrapStrict<T>(x); }",
      "",
    ].join("\n"),
  })).toEqual(["E4002 main.szigyr 1:53", "E4002 main.szigyr 1:76", "E4002 main.szigyr 4:67"]);

  expect(run({
    "main.szigyr": [
      "function takeOwn<T extends Owned>(x: T): T { return x; }",
      "function passOk(a: Alloc): void {",
      "  const v = Vec.create<i32>(a, 1);",
      "  takeOwn(v);",
      "  takeOwn<Struct<{ x: i32 }>>({ x: 1 });",
      "}",
      "function bad(): void {",
      "  takeOwn<i32>(1);",
      '  takeOwn<string>("a");',
      "  takeOwn<Struct<{ readonly x: i32 }>>({ x: 1 });",
      "}",
      "",
    ].join("\n"),
  })).toEqual(["E2002 main.szigyr 10:11", "E2002 main.szigyr 8:11", "E2002 main.szigyr 9:11"]);

  expect(run({
    "main.szigyr": [
      "function enc<T extends Codec>(js: Js, x: T): JsRef { return js.encode<T>(x); }",
      "function badJson<T extends Codec>(x: T): string { return JSON.stringify<T>(x); }",
      "function dec<T extends Codec>(x: unknown): Result<T, CastError> { return cast<T>(x); }",
      "function bad(js: Js, a: Alloc): void { enc(js, Vec.create<i32>(a, 1)); }",
      "",
    ].join("\n"),
  })).toEqual(["E2002 main.szigyr 2:73", "E2002 main.szigyr 3:79", "E2002 main.szigyr 4:40"]);

  expect(run({
    "main.szigyr": [
      "interface I { m(): i32; }",
      "function f1<T extends Copy & Owned>(x: T): void {}",
      "function f2<T extends Key & Owned>(x: T): void {}",
      "function f3<T extends Codec & Owned>(x: T): void {}",
      "function f4<T extends I & Copy>(x: T): void {}",
      "function f5<T extends Copy<i32>>(x: T): void {}",
      "",
    ].join("\n"),
  })).toEqual([
    "E2002 main.szigyr 2:23",
    "E2002 main.szigyr 3:23",
    "E2002 main.szigyr 4:23",
    "E2002 main.szigyr 5:23",
    "E2002 main.szigyr 6:23",
  ]);

  for (const cap of ["Copy", "Native", "Owned", "Send", "Key", "Codec"]) {
    expect(run({ "main.szigyr": `function f<${cap}>(): void {}\ntype ${cap} = i32;\n` })).toEqual([
      "E1000 main.szigyr 1:12",
      "E1000 main.szigyr 2:6",
    ]);
  }

  expect(run({
    "main.szigyr": [
      'function boxStr(a: Alloc): void { "use owned"; "use unsafe"; const p = Ptr.box<string>(a, "hi"); }',
      'function recStr(x: { readonly s: string }): void { "use owned"; }',
      "",
    ].join("\n"),
  })).toEqual(["E4002 main.szigyr 1:91", "E4002 main.szigyr 2:20", "E4007 main.szigyr 1:80"]);

  expect(run({
    "main.szigyr": [
      "interface J { g<T extends Copy & Native>(x: T): T; }",
      "class C implements J { g<T extends Copy>(x: T): T { return x; } }",
      "function passOk(): void {",
      "  const fn1 = <T extends Copy & Native>(a: Alloc, x: T): Vec<T> => Vec.create<T>(a, 1);",
      "}",
      "",
    ].join("\n"),
  })).toEqual(["E2002 main.szigyr 2:20"]);

  const linesOf = (files: Record<string, string>) => run(files).map((s) => s.replace(/:\d+$/, ""));

  // Syntax & shadowing checks for using / await using / Resource / Disposable / AsyncDisposable
  expect(linesOf({
    "main.szigyr": [
      "class D implements Disposable { dispose(): void {} }",
      "using top = new D();",
      "function f(): void {",
      "  for (using x = new D();;) break;",
      "  await using y = new D();",
      "}",
      "",
    ].join("\n"),
  })).toEqual(expect.arrayContaining([
    "E1000 main.szigyr 2",
    "E1000 main.szigyr 4",
    "E1000 main.szigyr 5",
  ]));

  expect(linesOf({
    "main.szigyr": [
      "type Disposable = i32;",
      "type AsyncDisposable = i32;",
      "function g(Resource: i32): void {}",
      "",
    ].join("\n"),
  })).toEqual([
    "E1000 main.szigyr 1",
    "E1000 main.szigyr 2",
    "E1000 main.szigyr 3",
  ]);

  // Disposable / AsyncDisposable / Resource type, ownership, safety, and effect rules
  expect(linesOf({
    "main.szigyr": [
      "class NotDisp {}",
      "class SyncDisp implements Disposable { dispose(): void {} }",
      "async function badDisp(): Promise<void> {",
      "  using a = new NotDisp();",
      "  await using b = new SyncDisp();",
      "}",
      "function freeVec(v: Vec<i32>): void {}",
      "function takeTwo(a: Ref<Vec<i32>>, b: Vec<i32>): void {}",
      "function takeTwoRev(a: Vec<i32>, b: Ref<Vec<i32>>): void {}",
      "function badRes(alloc: Alloc, param: Resource<Vec<i32>>): Resource<Vec<i32>> {",
      "  const e = Resource.own(Vec.create<i32>(alloc, 1), freeVec);",
      "  using r = Resource.own(Vec.create<i32>(alloc, 1), freeVec);",
      "  r.borrow();",
      "  takeTwo(r.borrow(), r.take());",
      "  using r2 = Resource.own(Vec.create<i32>(alloc, 1), freeVec);",
      "  takeTwoRev(r2.take(), r2.borrow());",
      "  using r3 = Resource.own(Vec.create<i32>(alloc, 1), freeVec);",
      "  const moved = r3.take();",
      "  const stale = r3.borrow();",
      "  using r4 = Resource.own(Vec.create<i32>(alloc, 1), freeVec);",
      "  return r4;",
      "}",
      "type RtBox = Struct<{ x: i32 }>;",
      "function freePtrRt(p: Ptr<u8>): void { 'use rt'; 'use unsafe'; }",
      "function cleanBoxStrict(l: Log, b: RtBox): void { 'use owned'; }",
      "function badRt(l: Log): void {",
      "  'use rt';",
      "  using r = Resource.ownWith<RtBox, Log>({ x: 1 }, l, cleanBoxStrict);",
      "}",
      "function badPtrUnsafe(p: Ptr<u8>): void {",
      "  'use rt';",
      "  using r = Resource.own(p, freePtrRt);",
      "}",
      "",
    ].join("\n"),
  })).toEqual(expect.arrayContaining([
    "E2002 main.szigyr 4",
    "E2002 main.szigyr 5",
    "E3004 main.szigyr 10",
    "E3004 main.szigyr 11",
    "E3004 main.szigyr 13",
    "E3005 main.szigyr 14",
    "E3005 main.szigyr 16",
    "E3001 main.szigyr 19",
    "E4006 main.szigyr 28",
    "E4008 main.szigyr 32",
  ]));

  // AudioStream is assignable to AsyncDisposable and usable with `await using`
  expect(run({
    "main.szigyr": [
      "function noop(st: f64, out: Mut<Slice<f32>>, frames: usize): void { 'use rt'; }",
      "export async function main(sys: System): Promise<void> {",
      "  const r = await sys.audio.open({ sampleRate: 48000, channels: 2 }, 0, noop);",
      "  if (r.kind === 'ok') {",
      "    await using s: AsyncDisposable = r.value;",
      "  }",
      "}",
      "",
    ].join("\n"),
  })).toEqual([]);
});

it("E2002 suggests >>> for unsigned >> and >> for signed >>>", () => {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-shift-`));
  const f = join(dir, "main.szigyr");
  writeFileSync(f, `function badShifts(a: u32, b: i32): i32 {
  const x = a >> 1;
  return b >>> 1;
}
`);
  const ds = check(f);
  expect(ds).toHaveLength(2);
  expect(ds[0]).toMatchObject({ code: "E2002", message: expect.stringContaining(">>>") });
  expect(ds[1]).toMatchObject({ code: "E2002", message: expect.stringContaining(">>") });
});

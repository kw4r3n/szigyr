// P2 behaviour that the conformance corpus does not pin (D009 - D012).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { check, CLI_NAME, deterministicFunctions, rtTrapSites } from "../src/index.ts";

/** Writes the files to a fresh directory and checks `main.ts`. */
function run(files: Record<string, string>): string[] {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-`));
  for (const [n, src] of Object.entries(files)) writeFileSync(join(dir, n), src);
  return check(join(dir, "main.ts")).map((d) => `${d.code} ${d.file.split("/").pop()} ${d.range.start.line}:${d.range.start.col}`).sort();
}

it("importing a name the module does not export is E7001 at the name, in P1 (Q009)", () => {
  const got = run({
    "main.ts": 'import { a, b as c } from "./a.ts";\nfunction f(): f64 { return nope; }\n',
    "a.ts": "export function a(): void {}\nfunction b(): void {}\n",
  });
  expect(got).toEqual(["E7001 main.ts 1:13"]); // P2 (E2000 for `nope`) does not run
});

it("exported aliases resolve across files", () => {
  expect(run({
    "main.ts": 'import { two as dos, P } from "./a.ts";\nexport function f(p: P): f64 { return p.x + dos(); }\n',
    "a.ts": "function two(): f64 { return 2; }\nexport type P = { readonly x: f64 };\nexport { two };\n",
  })).toEqual([]);
});

it("readonly behind a type alias is checked in P2 (Q072)", () => {
  expect(run({ "main.ts": "type P = { x: i32 };\nconst O: P = { x: 1 };\n" })).toEqual(["E5002 main.ts 2:14"]);
  expect(run({ "main.ts": "type P = { readonly x: i32 };\nconst O: P = { x: 1 };\n" })).toEqual([]);
  expect(run({ "main.ts": "type A = Array<i32>;\nconst O: A = [1];\n" })).toEqual(["E5002 main.ts 2:14"]);
});

it("E5001 for a global authority carries a fix that takes the authority as a parameter (Q073)", () => {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-`));
  writeFileSync(join(dir, "main.ts"), 'function s(n: i32): void {\n  console.log("hi");\n}\n');
  const [d] = check(join(dir, "main.ts"));
  expect(d?.code).toBe("E5001");
  expect(d?.data).toEqual({ name: "console", authority: "Log" });
  expect(d?.fixes?.[0]?.edits).toEqual([{ range: { start: { line: 1, col: 18 }, end: { line: 1, col: 18 } }, newText: ", log: Log" }]);
  writeFileSync(join(dir, "main.ts"), 'function s(): void {\n  console.log("hi");\n}\n');
  expect(check(join(dir, "main.ts"))[0]?.fixes?.[0]?.edits).toEqual([{ range: { start: { line: 1, col: 12 }, end: { line: 1, col: 12 } }, newText: "log: Log" }]);
});

it("answers which functions are deterministic (§7.3, Q062)", () => {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-`));
  writeFileSync(join(dir, "main.ts"), [
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
  expect(deterministicFunctions(join(dir, "main.ts"))).toEqual({
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
  expect(run({ "main.ts": src + "\n" }).map((s) => s.replace(" main.ts", ""))).toEqual(want);
});

it("the D050 fallback stays silent when a signature already reported", () => {
  expect(run({ "main.ts": "function f(x: Nope): i32 { return x.y; }\n" })).toEqual(["E2000 main.ts 1:15"]);
  expect(run({ "main.ts": "type A = Array<A>;\nfunction g(a: A): string { return a[0]; }\n" }).filter((d) => d.startsWith("E2002")).length).toBe(1);
});

it("one diagnostic per code and position (Q133)", () => {
  expect(run({ "main.ts": "async function g(): Promise<void> {}\nfunction f(): void { const a = [g()]; }\n" })).toEqual(["E2002 main.ts 2:33"]);
});

it("lists the trap sites of rt functions (§6)", () => {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-`));
  writeFileSync(join(dir, "main.ts"), [
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
  expect(rtTrapSites(join(dir, "main.ts"))).toEqual({
    k: [at("T004", 3, 3), at("T002", 4, 5), at("T001", 4, 10), at("T007", 4, 10), at("T001", 4, 25), at("T003", 4, 27), at("T001", 5, 5), at("T001", 6, 10), at("T009", 6, 13)],
  });
});

it("determinism checks generic class type arguments across parameters (§7.3)", () => {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-det-`));
  writeFileSync(join(dir, "main.ts"), [
    "class Box<T> { readonly v: T; constructor(v: T) { this.v = v; } }",
    "export function leak(a: Box<i32>, b: Box<Clock>): f64 { return b.v.nowMs(); }",
    "export function leak2(b: Box<Clock>, a: Box<i32>): f64 { return b.v.nowMs(); }",
    "export function pure(a: Box<i32>, b: Box<i32>): i32 { return a.v + b.v; }",
    "",
  ].join("\n"));
  expect(deterministicFunctions(join(dir, "main.ts"))).toEqual({ leak: false, leak2: false, pure: true });
});

it("lists only T007 for rem and T003 for usize-returning C calls (§3, §14.2)", () => {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-traps-`));
  writeFileSync(join(dir, "main.ts"), [
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
  expect(rtTrapSites(join(dir, "main.ts"))).toEqual({
    r: [at("T007", 7, 10)],
    cb: [at("T003", 12, 10)],
  });
});

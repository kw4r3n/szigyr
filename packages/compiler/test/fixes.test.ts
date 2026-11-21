// SPEC §11 `fixes`: applying a diagnostic's fix must remove that diagnostic.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { main as cliMain } from "../src/cli.ts";
import { check, CLI_NAME, type Diagnostic } from "../src/index.ts";

const offset = (src: string, p: { line: number; col: number }): number => src.split("\n").slice(0, p.line - 1).reduce((n, l) => n + l.length + 1, 0) + p.col - 1;

/** Checks `src`, applies the first fix of the first diagnostic, and returns both the diagnostic and the rewritten source. */
function fixOnce(src: string): { d: Diagnostic; fixed: string; after: Diagnostic[] } {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-`));
  const f = join(dir, "main.szigyr");
  writeFileSync(f, src);
  const d = check(f)[0]!;
  const edits = [...d.fixes![0]!.edits].sort((a, b) => offset(src, b.range.start) - offset(src, a.range.start));
  let fixed = src;
  for (const e of edits) fixed = fixed.slice(0, offset(src, e.range.start)) + e.newText + fixed.slice(offset(src, e.range.end));
  writeFileSync(f, fixed);
  return { d, fixed, after: check(f) };
}

const cases: [string, string, string, string][] = [
  ["E1001", "export function f(): i32 {\n  var x: i32 = 1;\n  return x;\n}\n", "let x: i32", "var x"],
  ["E1001", "var x: i32 = 1;\n", "const x: i32", "var x"],
  ["E1002", "export function f(a: i32): boolean {\n  return a == 1;\n}\n", "a === 1", "=="],
  ["E1002", "export function f(a: i32): boolean {\n  return a != 1;\n}\n", "a !== 1", "!="],
  ["E1000", "export function f(xs: i32[]): usize {\n  return xs.length;\n}\n", "Array<i32>", "[]"],
  ["E1000", "export function f(): void {\n  let i: i32 = 0;\n  i++;\n}\n", "i += 1;", "i++"],
  ["E1000", "export function f(): void {\n  for (let i: i32 = 3; i > 0; i--) {}\n}\n", "i -= 1)", "i--"],
  ["E2003", "export function f(a: Array<f64>): boolean {\n  let i = 0;\n  return i < a.length;\n}\n", "let i: usize = 0", "let i = 0"],
  ["E2003", "export function f(n: u8): u8 {\n  let i = 1;\n  return n + i;\n}\n", "let i: u8 = 1", "let i = 1"],
  ["E1000", 'export function f(): i32 {\n  "use strict";\n  return 1;\n}\n', '"use owned"', '"use strict"'],
  ["E1000", "export function f(): i64 {\n  return 1n;\n}\n", "return 1;", "1n"],
  ["E1008", "export function f(x?: i32): i32 {\n  return x ?? 0;\n}\n", "x: i32 | null", "x?: i32"],
  ["E1008", "type P = { readonly x?: i32 };\nexport function f(p: P): i32 {\n  return p.x ?? 0;\n}\n", "x: i32 | null", "x?: i32"],
  ["E5001", 'export function f(): void {\n  console.log("hi");\n}\n', "log.info", "console.log"],
  ["E5001", "export function f(): f64 {\n  return Date.now();\n}\n", "clock.nowMs", "Date.now"],
  ["E5001", "export function f(): f64 {\n  return Math.random();\n}\n", "random.nextF64", "Math.random"],
  ["E2002", "export function f(a: i32, b: i32): i32 {\n  return a % b;\n}\n", "rem(a, b)", "a % b"],
  ["E2002", "export function f(a: i32, b: i32): i32 {\n  let x = a;\n  x %= b;\n  return x;\n}\n", "x = rem(x, b)", "x %= b"],
  ["E2007", "export function f(a: i32, b: i32): i32 {\n  let x = a;\n  x /= b;\n  return x;\n}\n", "x = divTrunc(x, b)", "x /= b"],
  ["E2002", 'export function f(a: string, b: string): string {\n  return a + b;\n}\n', "`${a}${b}`", "a + b"],
  ["E2005", 'type Color = "red" | "green" | "blue";\nexport function f(c: Color): i32 {\n  switch (c) {\n    case "red": return 1;\n  }\n}\n', 'case "green": panic("unhandled");', "E2005"],
];

for (const [code, src, has, _] of cases) {
  it(`${code}: the fix removes the diagnostic (${has})`, () => {
    const { d, fixed, after } = fixOnce(src);
    expect(d.code).toBe(code);
    expect(fixed).toContain(has);
    expect(after.filter((x) => x.code === code && x.range.start.line === d.range.start.line)).toEqual([]);
  });
}

it("a postfix ++ whose value is used gets no fix (the rewrite would change the value)", () => {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-`));
  writeFileSync(join(dir, "main.szigyr"), "export function f(): i32 {\n  let i: i32 = 0;\n  return i++;\n}\n");
  expect(check(join(dir, "main.szigyr"))[0]!.fixes).toBeUndefined();
});

it("attaches structured data and fixes for E2002/E2003/E2004/E2005/E2007/E4001/E7001", () => {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-`));
  writeFileSync(join(dir, "dep.szigyr"), "export function g(): i32 { return 1; }\n");
  writeFileSync(join(dir, "main.szigyr"), `import { g } from "./dep.ts";
type Color = "red" | "green" | "blue";
function helper(): i32 { return g(); }
export function f(a: i32, b: i32, c: f64, col: Color): i32 {
  "use rt";
  const badType: i32 = true;
  const mixed = a + c;
  if (a) { return 0; }
  switch (col) {
    case "red": break;
  }
  const div = a / b;
  return helper();
}
`);
  const ds = check(join(dir, "main.szigyr"));
  const byCode = (code: string) => ds.find((d) => d.code === code);
  expect(byCode("E7001")?.fixes?.[0]?.edits[0]?.newText).toBe('"./dep.szigyr"');
  expect(byCode("E2002")?.data).toEqual({ expected: "i32", actual: "boolean" });
  expect(byCode("E2003")?.data).toEqual({ left: "i32", right: "f64" });
  expect(byCode("E2004")?.data).toEqual({ actual: "i32" });
  expect(byCode("E2005")?.data).toEqual({ missing: ["green", "blue"] });
  const e2007 = byCode("E2007");
  expect(e2007?.data).toEqual({ type: "i32" });
  expect(e2007?.fixes?.[0]).toMatchObject({ title: "use divTrunc", edits: [{ newText: "divTrunc(a, b)" }] });
  expect(byCode("E4001")?.data).toEqual({ callerLayer: "rt", calleeLayer: "managed" });
});

it("attaches concrete-type, resource-escape, conflictAt, cycle, and CLI kind/mismatch details", async () => {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-`));
  const genericCast = join(dir, "cast.szigyr");
  writeFileSync(genericCast, "export function decodeIt<T extends Codec>(u: unknown): T | null {\n  const r = cast<T>(u);\n  return r.kind === \"ok\" ? r.value : null;\n}\n");
  expect(check(genericCast)[0]?.data).toEqual({ reason: "concrete-type-required", actual: "T", requiredCap: "Codec" });

  const resEsc = join(dir, "res.szigyr");
  writeFileSync(resEsc, [
    "function dropVec(v: Vec<i32>): void { \"use owned\"; }",
    "export function f(a: Alloc): void {",
    "  \"use owned\";",
    "  using r = Resource.own(Vec.create<i32>(a, 1), dropVec);",
    "  const x = r;",
    "}",
  ].join("\n"));
  expect(check(resEsc).find((d) => d.code === "E3004")?.data).toEqual({ variable: "r", kind: "resource-escape" });

  const excl = join(dir, "excl.szigyr");
  writeFileSync(excl, [
    "function two(a: Mut<Vec<i32>>, b: Ref<Vec<i32>>): void { \"use owned\"; }",
    "export function f(a: Alloc): void {",
    "  \"use owned\";",
    "  const v = Vec.create<i32>(a, 2);",
    "  two(v, v);",
    "}",
  ].join("\n"));
  expect(check(excl).find((d) => d.code === "E3005")?.data).toEqual({
    variable: "v",
    conflictAt: { line: 5, col: 7 },
  });

  const cycle = join(dir, "cycle.szigyr");
  writeFileSync(cycle, [
    "function a(n: i32): i32 { \"use rt\"; return b(n); }",
    "function b(n: i32): i32 { \"use rt\"; return a(n); }",
  ].join("\n"));
  const cycDiag = check(cycle).find((d) => d.code === "E4005");
  expect(cycDiag?.data?.cycle).toEqual(["a", "b", "a"]);

  let cliOut = "";
  const code = await cliMain(["check", "--json", cycle], (s) => { cliOut += s; }, () => {});
  expect(code).toBe(1);
  expect(JSON.parse(cliOut.trim().split("\n")[0]!)).toMatchObject({ kind: "diagnostic", code: "E4005" });
});

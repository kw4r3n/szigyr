// SPEC §11 `fixes`: applying a diagnostic's fix must remove that diagnostic.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
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

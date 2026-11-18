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
  const f = join(dir, "main.ts");
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
  writeFileSync(join(dir, "main.ts"), "export function f(): i32 {\n  let i: i32 = 0;\n  return i++;\n}\n");
  expect(check(join(dir, "main.ts"))[0]!.fixes).toBeUndefined();
});

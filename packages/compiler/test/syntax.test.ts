// P1 over every conformance file with a single parse: no false positives outside P1 rejects,
// and exactly one diagnostic (the expected one) in each P1 reject (Q003: one violation per file).
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { check, CLI_NAME } from "../src/index.ts";
import { parseSources } from "../src/parse.ts";
import { checkSyntax, P1_CODE } from "../src/syntax.ts";
import { loadCases } from "./harness.ts";

const root = fileURLToPath(new URL("../../../conformance", import.meta.url));
const files = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? files(join(d, e.name)) : e.name.endsWith(".szigyr") ? [join(d, e.name)] : []);

it("P1 is silent outside P1 reject cases and reports exactly the expected diagnostic in them", () => {
  const paths = files(root);
  const parsed = parseSources(Object.fromEntries(paths.map((f) => [f, readFileSync(f, "utf8")])));
  const want = new Map(loadCases(root).filter((c) => c.kind === "reject" && P1_CODE.test(c.at!.code)).map((c) => [resolve(c.entry), c.at!]));
  expect(want.size).toBeGreaterThanOrEqual(29);
  const problems: string[] = [];
  for (const p of paths) {
    const got = checkSyntax(parsed.get(resolve(p))!).map((d) => `${d.code} @ ${d.range.start.line}:${d.range.start.col}`);
    const w = want.get(resolve(p));
    const exp = w ? [`${w.code} @ ${w.line}:${w.col}`] : [];
    if (JSON.stringify(got) !== JSON.stringify(exp)) problems.push(`${p.slice(root.length + 1)}: expected ${JSON.stringify(exp)}, got ${JSON.stringify(got)}`);
  }
  expect(problems).toEqual([]);
});

it("a parser error is E1000 at the error and stops the walk (Q070)", () => {
  const pf = parseSources({ "/m/e.ts": "var x = 1;\nfunction f(: void {}\n" }).get("/m/e.ts")!;
  const got = checkSyntax(pf);
  expect(got.length).toBeGreaterThan(0);
  expect(got.every((d) => d.code === "E1000")).toBe(true);
  expect(got[0]!.range.start).toEqual({ line: 2, col: 12 }); // no E1001 for `var`: the AST is not walked
});

it("check follows relative imports and reports a missing file at the specifier (Q009)", () => {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-`));
  writeFileSync(join(dir, "main.szigyr"), 'import { a } from "./a.szigyr";\nimport { b } from "./b.szigyr";\n');
  writeFileSync(join(dir, "a.szigyr"), "export function a(): void {\n  var x: i32 = 1;\n}\n");
  const got = check(join(dir, "main.szigyr")).map((d) => `${d.code} ${d.file.split("/").pop()} ${d.range.start.line}:${d.range.start.col}`);
  expect(got.sort()).toEqual(["E1001 a.szigyr 2:3", "E7001 main.szigyr 2:19"]);
});

// Forms the conformance corpus does not pin: default-deny branches and defaults from open questions.
const forms: [string, string, string[]][] = [
  ["postfix ++", "function f(x: i32): void { x++; }", ["E1000@1:28"]],
  ["typeof value", "function f(x: i32): boolean { return typeof x === \"number\"; }", ["E1000@1:38"]],
  ["bitwise compound assignment (Q071)", "function f(x: i32): void { x &= 1; }", ["E1000@1:30"]],
  ["nested destructuring (Q052)", "type P = { readonly a: Q };\nfunction f(p: P): void { const { a: { b } } = p; }", ["E1000@2:37"]],
  ["destructuring assignment", "function f(a: i32, b: i32): void { [a, b] = [b, a]; }", ["E1000@1:36"]],
  ["'this' parameter", "function f(this: X): void {}", ["E1000@1:12"]],
  ["let without initializer (Q055)", "function f(): void { let x: i32; }", ["E1000@1:26"]],
  ["overload", "export function f(): void;\nexport function f(): void {}", ["E1000@1:1"]],
  ["directive in a method (Q039)", "class A { m(): void { \"use owned\"; } }", ["E1000@1:23"]],
  ["second file directive (Q039)", "\"use rt\";\n\"use owned\";\nfunction f(): void {}", ["E1000@2:1"]],
  ["ensures in an async function (Q056)", "async function f(): Promise<i32> { ensures((r: i32) => r > 0); return 1; }", ["E6001@1:36"]],
  ["declaration merging", "type A = { readonly x: i32 };\nfunction A(): void {}", ["E1000@2:10"]],
  ["builtin name as parameter (Q010)", "function f(ok: i32): void {}", ["E1000@1:12"]],
  ["exported generator (Q004)", "export function* g(): void { yield 1; }", ["E1000@1:8"]],
  ["template literal type", "type T = `a${string}`;", ["E1000@1:10"]],
  ["module-level expression (Q054)", "f();", ["E1000@1:1"]],
  ["module-level const with a call (Q054)", "const X: Point = { x: 1, y: f() };", ["E5002@1:18"]],
  ["readonly behind an alias is left to P2 (Q072)", "type P = { x: i32 };\nconst O: P = { x: 1 };", []],
  ["static field without readonly (Q054)", "class A { static X: i32 = 1; }", ["E5002@1:27"]],
  ["specifier without .szigyr (Q009)", "import { a } from \"./a\";", ["E7001@1:19"]],
  ["import type (Q009)", "import type { a } from \"./a.szigyr\";", ["E7001@1:1"]],
  ["import { default as g } (Q009)", "import { default as g } from \"./a.szigyr\";", ["E7001@1:1"]],
  ["export { f as default } (Q009)", "function f(): void {}\nexport { f as default };", ["E1003@2:1"]],
  ["named import and export with aliases", "import { a as b } from \"./a.szigyr\";\nexport { b, b as c };", []],
  ["optional call", "function f(g: () => void): void { g?.(); }", ["E1000@1:35"]],
  ["empty statement", "function f(): void { ; }", ["E1000@1:22"]],
  ["public method", "class A { public m(): void {} }", ["E1000@1:11"]],
  ["override method", "class A { override m(): void {} }", ["E1000@1:11"]],
  ["regex literal", "function f(): void { const r = /a/; }", ["E1000@1:32"]],
  ["as const is rejected (Q026)", "function f(): i32 { const x: i32 = 1 as const; return x; }", ["E1005@1:38"]],
];

it.each(forms)("%s", (_name, src, want) => {
  const pf = parseSources({ "/m/x.ts": src }).get("/m/x.ts")!;
  expect(checkSyntax(pf).map((d) => `${d.code}@${d.range.start.line}:${d.range.start.col}`)).toEqual(want);
});

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
  ["E2003", "export function f(a: Array<f64>): boolean {\n  let i = 0;\n  return i < a.length;\n}\n", "let i: usize = 0", "let i = 0"],
  ["E2003", "export function f(n: u8): u8 {\n  let i = 1;\n  return n + i;\n}\n", "let i: u8 = 1", "let i = 1"],
  ["E1000", 'export function f(): i32 {\n  "use strict";\n  return 1;\n}\n', '"use owned"', '"use strict"'],
  ["E1000", "export function f(): i64 {\n  return 1n;\n}\n", "return 1;", "1n"],
  ["E1008", "export function f(x?: i32): i32 {\n  return x ?? 0;\n}\n", "x: i32 | null", "x?: i32"],
  ["E1008", "type P = { readonly x?: i32 };\nexport function f(p: P): i32 {\n  return p.x ?? 0;\n}\n", "x: i32 | null", "x?: i32"],
  ["E5001", 'export function f(): void {\n  console.log("hi");\n}\n', "log.info", "console.log"],
  ["E5001", "export function f(): f64 {\n  return Date.now();\n}\n", "clock.nowMs", "Date.now"],
  ["E5001", "export function f(): f64 {\n  return Math.random();\n}\n", "random.nextF64", "Math.random"],
  ["E2007", "export function f(a: i32, b: i32): i32 {\n  let x = a;\n  x /= b;\n  return x;\n}\n", "x = divTrunc(x, b)", "x /= b"],
  ["E2004", "export function f(s: string | null): usize {\n  if (s) return s.length;\n  return 0;\n}\n", "s !== null", "if (s)"],
  ["E2004", "export function f(s: string | null): boolean {\n  return s && s.length > 0;\n}\n", "s !== null", "return s &&"],
  ["E2002", 'export function f(x: i32): string {\n  return "n=" + x;\n}\n', "`n=${x}`", '"n=" + x'],
  ["E2002", 'export function f(x: i32): string {\n  return x + "px";\n}\n', "`${x}px`", 'x + "px"'],
  ["E2002", 'export function f(b: boolean): string {\n  return "ok=" + b;\n}\n', "`ok=${b}`", '"ok=" + b'],
  ["E2003", "export function f(a: i32, b: f64): f64 {\n  return a + b;\n}\n", "f64(a)", "a + b"],
  ["E2003", "export function f(a: i32, b: f64): i32 {\n  return a + b;\n}\n", "i32(b)", "a + b"],
  ["E2003", "export function f(a: i32, b: f64): i32 {\n  let x: i32 = a;\n  x += b;\n  return x;\n}\n", "i32(b)", "+= b"],
  ["E2005", 'type Color = "red" | "green" | "blue";\nexport function f(c: Color): i32 {\n  switch (c) {\n    case "red": return 1;\n  }\n}\n', 'case "green": panic("unhandled");', "E2005"],
  ["E2000", "export function f(): f64 {\n  return NaN;\n}\n", "Number.NaN", "NaN"],
  ["E2000", "export function f(): f64 {\n  return Infinity;\n}\n", "Number.POSITIVE_INFINITY", "Infinity"],
  ["E2000", "export function f(x: f64): boolean {\n  return isNaN(x);\n}\n", "Number.isNaN", "isNaN"],
  ["E2000", "export function f(s: string): f64 {\n  return parseFloat(s);\n}\n", "Number.parseFloat", "parseFloat"],
  ["E2000", "export function f(x: f64 | null): boolean {\n  return x === undefined;\n}\n", "x === null", "undefined"],
  ["E2000", "export function f(x: number | undefined): number {\n  if (x === null) return 0;\n  return x;\n}\n", "number | null", "undefined"],
  ["E2004", "export function f(s: string): i32 {\n  if (s) return 1;\n  return 0;\n}\n", 's !== ""', "if (s)"],
  ["E2004", "export function f(i: i32): i32 {\n  if (i) return 1;\n  return 0;\n}\n", "i !== 0", "if (i)"],
  ["E2004", "export function f(a: usize, b: usize): i32 {\n  if (a + b) return 1;\n  return 0;\n}\n", "(a + b) !== 0", "if (a + b)"],
  ["E2004", "export function f(s: string): boolean {\n  return !s;\n}\n", 's === ""', "!s"],
  ["E2004", "export function f(i: i32): boolean {\n  return !i;\n}\n", "i === 0", "!i"],
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
  expect(byCode("E2004")?.data).toEqual({ kind: "truthiness", actual: "i32" });
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

  // E2004 boolean | null gets no '!== null' fix; compound E2003 only offers RHS conversion
  const boolNull = join(dir, "bool-null.szigyr");
  writeFileSync(boolNull, "export function f(b: boolean | null): i32 {\n  if (b) return 1;\n  return 0;\n}\n");
  expect(check(boolNull)[0]?.fixes).toBeUndefined();

  const compound = join(dir, "compound-e2003.szigyr");
  writeFileSync(compound, "export function f(a: i32, b: f64): i32 {\n  let x: i32 = a;\n  x += b;\n  return x;\n}\n");
  const cd = check(compound).find((d) => d.code === "E2003");
  expect(cd?.fixes?.map((fx) => fx.title)).toEqual(["convert right to 'i32'"]);

  // safe Part D fixes: public modifier on class member & mutable TypeLiteral in strict code
  const pubFile = join(dir, "pub.szigyr");
  writeFileSync(pubFile, "export class A {\n  public m(): i32 { return 1; }\n}\n");
  const pubRc = await cliMain(["check", pubFile], () => {}, () => {});
  expect(pubRc).toBe(1);
  let fixOut = "";
  const fixRc = await cliMain(["check", "--fix", pubFile], (s) => { fixOut += s; }, () => {});
  expect(fixRc).toBe(0);
  expect(readFileSync(pubFile, "utf8")).not.toContain("public");
  expect(check(pubFile)).toEqual([]);

  const mutRecFile = join(dir, "mut-rec.szigyr");
  writeFileSync(mutRecFile, "function f(p: { x: i32; y: i32 }): i32 {\n  \"use owned\";\n  return p.x + p.y;\n}\n");
  const mrBefore = check(mutRecFile);
  expect(mrBefore).toHaveLength(1);
  expect(mrBefore[0]).toMatchObject({ code: "E4002", data: { kind: "mutable-record" } });
  expect(mrBefore[0]!.fixes).toBeUndefined();
  const mrRc = await cliMain(["check", "--fix", mutRecFile], () => {}, () => {});
  expect(mrRc).toBe(1);
  expect(check(mutRecFile)).toEqual(mrBefore);

  // Mutable strict record with field assignment (like fix-r1) and managed caller passing mutable record (like fix-c1):
  // check --fix must not introduce new E2002 diagnostics.
  const mutatedRecFile = join(dir, "mut-rec-write.szigyr");
  writeFileSync(mutatedRecFile, "function f(r: { a: i32 }): i32 {\n  \"use owned\";\n  r.a = 5;\n  return r.a;\n}\nexport function main(sys: System): void { sys.log.info(\"x\"); }\n");
  const r1Before = check(mutatedRecFile);
  expect(r1Before.map((d) => d.code)).toEqual(["E4002"]);
  expect(r1Before[0]!.fixes).toBeUndefined();
  expect(await cliMain(["check", "--fix", mutatedRecFile], () => {}, () => {})).toBe(1);
  expect(check(mutatedRecFile)).toEqual(r1Before);

  const managedCallerRecFile = join(dir, "mut-rec-caller.szigyr");
  writeFileSync(managedCallerRecFile, "function f(r: { a: i32 }): i32 {\n  \"use owned\";\n  return r.a;\n}\nexport function main(sys: System): void {\n  const r: { a: i32 } = { a: 1 };\n  const n = f(r);\n  r.a = 7;\n  sys.log.info(`${n}${f(r)}`);\n}\n");
  const c1Before = check(managedCallerRecFile);
  expect(c1Before.map((d) => d.code)).toEqual(["E4002"]);
  expect(c1Before[0]!.fixes).toBeUndefined();
  expect(await cliMain(["check", "--fix", managedCallerRecFile], () => {}, () => {})).toBe(1);
  expect(check(managedCallerRecFile)).toEqual(c1Before);
});

it("rejects rest/extra-default builtin callbacks with E2002 callback-extra-params and fixes non-inline callbacks", async () => {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-cb-`));

  // Non-inline rest callback (m4/m8 shape) gets arrow-wrap --fix that makes check clean
  const restFile = join(dir, "cb-rest.szigyr");
  writeFileSync(restFile, [
    "function cnt(...xs: Array<usize>): usize { return xs.length; }",
    "export function main(sys: System): void {",
    "  const a: Array<usize> = [10, 20, 30];",
    "  const r = a.map(cnt);",
    "  sys.log.info(`${r.join(\",\")}`);",
    "}",
    "",
  ].join("\n"));
  const restDiag = check(restFile)[0];
  expect(restDiag?.code).toBe("E2002");
  expect(restDiag?.data).toMatchObject({ kind: "callback-extra-params" });
  expect(restDiag?.fixes?.[0]?.title).toBe("wrap in arrow function");
  expect(await cliMain(["check", "--fix", restFile], () => {}, () => {})).toBe(0);
  expect(readFileSync(restFile, "utf8")).toContain("a.map((p0, p1) => cnt(p0, p1))");
  expect(check(restFile)).toEqual([]);

  // Non-inline trailing-default callback (m6 shape) gets arrow-wrap --fix that makes check clean
  const defFile = join(dir, "cb-def.szigyr");
  writeFileSync(defFile, [
    "function g(x: usize, i: usize, z: i32 = 5): i32 { return z; }",
    "export function main(sys: System): void {",
    "  const a: Array<usize> = [10, 20, 30];",
    "  const r = a.map(g);",
    "  sys.log.info(`${r.length}`);",
    "}",
    "",
  ].join("\n"));
  const defDiag = check(defFile)[0];
  expect(defDiag?.code).toBe("E2002");
  expect(defDiag?.data).toMatchObject({ kind: "callback-extra-params" });
  expect(defDiag?.fixes?.[0]?.title).toBe("wrap in arrow function");
  expect(await cliMain(["check", "--fix", defFile], () => {}, () => {})).toBe(0);
  expect(readFileSync(defFile, "utf8")).toContain("a.map((p0, p1) => g(p0, p1))");
  expect(check(defFile)).toEqual([]);

  // 0-arg host callback (Test.traps) gets `() => fn()` fix
  const trapFile = join(dir, "cb-zero.szigyr");
  writeFileSync(trapFile, [
    "function helper(x: i32 = 5): void { panic(\"boom\"); }",
    "test(\"zero-arg wrap\", (t: Test) => {",
    "  t.traps(\"T006\", helper);",
    "});",
    "",
  ].join("\n"));
  const trapDiag = check(trapFile)[0];
  expect(trapDiag?.code).toBe("E2002");
  expect(trapDiag?.data).toMatchObject({ kind: "callback-extra-params" });
  expect(await cliMain(["check", "--fix", trapFile], () => {}, () => {})).toBe(0);
  expect(readFileSync(trapFile, "utf8")).toContain("t.traps(\"T006\", () => helper())");
  expect(check(trapFile)).toEqual([]);

  // Inline arrow with rest/extra-default gets E2002 callback-extra-params with NO fix
  const inlineFile = join(dir, "cb-inline.szigyr");
  writeFileSync(inlineFile, [
    "export function main(sys: System): void {",
    "  const s = new Set<string>([\"a\"]);",
    "  s.forEach((...xs: Array<string>): void => { sys.log.info(`${xs.length}`); });",
    "}",
    "",
  ].join("\n"));
  const inlineDiag = check(inlineFile)[0];
  expect(inlineDiag?.code).toBe("E2002");
  expect(inlineDiag?.data).toMatchObject({ kind: "callback-extra-params" });
  expect(inlineDiag?.fixes).toBeUndefined();

  // Call-site expression (fx1 shape) must NOT attach arrow-wrap fix (would duplicate mk calls)
  const callFile = join(dir, "cb-call.szigyr");
  writeFileSync(callFile, [
    "function cnt(...xs: Array<usize>): usize { return xs.length; }",
    "function mk(log: Log): (...xs: Array<usize>) => usize { log.info(\"mk\"); return cnt; }",
    "export function main(sys: System): void {",
    "  const a: Array<usize> = [10, 20, 30];",
    "  sys.log.info(`${a.map(mk(sys.log)).join(\",\")}`);",
    "}",
    "",
  ].join("\n"));
  const callDiag = check(callFile)[0];
  expect(callDiag?.code).toBe("E2002");
  expect(callDiag?.data).toMatchObject({ kind: "callback-extra-params" });
  expect(callDiag?.fixes).toBeUndefined();

  // Member on call expression must NOT attach fix either
  const callMemberFile = join(dir, "cb-call-member.szigyr");
  writeFileSync(callMemberFile, [
    "function cnt(...xs: Array<usize>): usize { return xs.length; }",
    "function mkRec(log: Log): { readonly f: (...xs: Array<usize>) => usize } { log.info(\"mk\"); return { f: cnt }; }",
    "export function main(sys: System): void {",
    "  const a: Array<usize> = [10, 20, 30];",
    "  sys.log.info(`${a.map(mkRec(sys.log).f).join(\",\")}`);",
    "}",
    "",
  ].join("\n"));
  const callMemberDiag = check(callMemberFile)[0];
  expect(callMemberDiag?.code).toBe("E2002");
  expect(callMemberDiag?.data).toMatchObject({ kind: "callback-extra-params" });
  expect(callMemberDiag?.fixes).toBeUndefined();

  // Pure member reference and annotated nullable local get arrow-wrap fix and become clean
  const memberFile = join(dir, "cb-member.szigyr");
  writeFileSync(memberFile, [
    "function cnt(...xs: Array<usize>): usize { return xs.length; }",
    "type CB = (x: usize, i: usize) => usize;",
    "export function main(sys: System): void {",
    "  const o: { readonly f: (...xs: Array<usize>) => usize } = { f: cnt };",
    "  const cb: CB | null = o.f;",
    "  sys.log.info(`${cb !== null ? cb(1, 2) : 0}`);",
    "}",
    "",
  ].join("\n"));
  const memberDiag = check(memberFile)[0];
  expect(memberDiag?.code).toBe("E2002");
  expect(memberDiag?.data).toMatchObject({ kind: "callback-extra-params" });
  expect(memberDiag?.message).toMatch(/^function '/);
  expect(memberDiag?.fixes?.[0]?.title).toBe("wrap in arrow function");
  expect(await cliMain(["check", "--fix", memberFile], () => {}, () => {})).toBe(0);
  expect(readFileSync(memberFile, "utf8")).toContain("const cb: CB | null = (p0, p1) => o.f(p0, p1);");
  expect(check(memberFile)).toEqual([]);

  // Reassignable let local (fx2 shape), mutable field (fx3 shape), field on let, and param get NO fix
  const unstableSources = [
    [
      "function cnt(...xs: Array<usize>): usize { return xs.length; }",
      "function one(...xs: Array<usize>): usize { return 100 + xs.length; }",
      "export function main(sys: System): void {",
      "  const a: Array<usize> = [10, 20, 30];",
      "  let f = cnt;",
      "  const cb: (x: usize, i: usize) => usize = f;",
      "  f = one;",
      "  sys.log.info(`${a.map(cb).join(\",\")}`);",
      "}",
      "",
    ].join("\n"),
    [
      "function cnt(...xs: Array<usize>): usize { return xs.length; }",
      "function one(...xs: Array<usize>): usize { return 100 + xs.length; }",
      "export function main(sys: System): void {",
      "  const a: Array<usize> = [10, 20, 30];",
      "  const o: { f: (...xs: Array<usize>) => usize } = { f: cnt };",
      "  const cb: (x: usize, i: usize) => usize = o.f;",
      "  o.f = one;",
      "  sys.log.info(`${a.map(cb).join(\",\")}`);",
      "}",
      "",
    ].join("\n"),
    [
      "function cnt(...xs: Array<usize>): usize { return xs.length; }",
      "export function main(sys: System): void {",
      "  let o: { readonly f: (...xs: Array<usize>) => usize } = { f: cnt };",
      "  const cb: (x: usize, i: usize) => usize = o.f;",
      "  sys.log.info(`${cb(1, 2)}`);",
      "}",
      "",
    ].join("\n"),
    [
      "export function wrap(a: Array<usize>, f: (...xs: Array<usize>) => usize): Array<usize> { return a.map(f); }",
      "",
    ].join("\n"),
  ];
  for (let i = 0; i < unstableSources.length; i++) {
    const f = join(dir, `cb-unstable-${i}.szigyr`);
    writeFileSync(f, unstableSources[i]!);
    const diag = check(f)[0];
    expect(diag?.code, unstableSources[i]).toBe("E2002");
    expect(diag?.data).toMatchObject({ kind: "callback-extra-params" });
    expect(diag?.message).toMatch(/^function '/);
    expect(diag?.fixes).toBeUndefined();
  }

  // Immutable local const gets arrow-wrap fix and becomes clean
  const constLocalFile = join(dir, "cb-const-local.szigyr");
  writeFileSync(constLocalFile, [
    "function cnt(...xs: Array<usize>): usize { return xs.length; }",
    "export function main(sys: System): void {",
    "  const f = cnt;",
    "  const cb: (x: usize, i: usize) => usize = f;",
    "  sys.log.info(`${cb(1, 2)}`);",
    "}",
    "",
  ].join("\n"));
  const constDiag = check(constLocalFile)[0];
  expect(constDiag?.fixes?.[0]?.title).toBe("wrap in arrow function");
  expect(await cliMain(["check", "--fix", constLocalFile], () => {}, () => {})).toBe(0);
  expect(check(constLocalFile)).toEqual([]);
});

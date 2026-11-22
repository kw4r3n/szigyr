import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { check, CLI_NAME, type Diagnostic } from "../src/index.ts";
import { explainCode } from "../src/explain.ts";

const offset = (src: string, p: { line: number; col: number }): number =>
  src.split("\n").slice(0, p.line - 1).reduce((n, l) => n + l.length + 1, 0) + p.col - 1;

function checkSrc(src: string): { file: string; diags: Diagnostic[] } {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-ai-`));
  const file = join(dir, "main.szigyr");
  writeFileSync(file, src);
  return { file, diags: check(file) };
}

function applyFirstFix(src: string): { diag: Diagnostic; fixed: string; after: Diagnostic[] } {
  const { file, diags } = checkSrc(src);
  const diag = diags[0]!;
  const edits = [...diag.fixes![0]!.edits].sort((a, b) => offset(src, b.range.start) - offset(src, a.range.start));
  let fixed = src;
  for (const e of edits) {
    fixed = fixed.slice(0, offset(src, e.range.start)) + e.newText + fixed.slice(offset(src, e.range.end));
  }
  writeFileSync(file, fixed);
  return { diag, fixed, after: check(file) };
}

describe("AI-friendly diagnostics, quick fixes, and suggestions", () => {
  it("reports specific E1000 messages and structured data for common TS constructs", () => {
    const inc = checkSrc("export function f(): void { let n: i32 = 0; n++; }\n").diags[0]!;
    expect(inc).toMatchObject({ code: "E1000", message: "'++' is not allowed; use '+= 1'", data: { kind: "inc-dec", op: "++" } });

    const dec = checkSrc("export function f(): void { let n: i32 = 1; --n; }\n").diags[0]!;
    expect(dec).toMatchObject({ code: "E1000", message: "'--' is not allowed; use '-= 1'", data: { kind: "inc-dec", op: "--" } });

    const tup = checkSrc("type Pair = [i32, string];\n").diags[0]!;
    expect(tup).toMatchObject({ code: "E1000", message: "tuple types are not allowed; use a record '{ readonly ... }' or 'Struct<{ ... }>'", data: { kind: "tuple-type" } });

    const ifaceField = checkSrc("interface Foo { readonly x: i32; }\n").diags[0]!;
    expect(ifaceField).toMatchObject({
      code: "E1000",
      message: "interface fields are not allowed (interfaces only declare methods); use 'type ... = { ... }' for records",
      data: { kind: "interface-field" },
    });

    const forIn = checkSrc("export function f(xs: Array<i32>): void { for (const k in xs) {} }\n").diags[0]!;
    expect(forIn).toMatchObject({ code: "E1000", message: "'for..in' is not allowed; use 'for..of' or an index loop", data: { kind: "for-in" } });

    const bitAndEq = checkSrc("export function f(x: i32): void { x &= 1; }\n").diags[0]!;
    expect(bitAndEq).toMatchObject({ code: "E1000", message: "operator '&=' is not allowed", data: { kind: "operator", op: "&=" } });

    const inter = checkSrc("type A = { readonly a: i32 };\ntype B = { readonly b: i32 };\ntype C = A & B;\n").diags[0]!;
    expect(inter).toMatchObject({ code: "E1000", data: { kind: "intersection-type" } });

    const keyofT = checkSrc("type K = keyof { readonly a: i32 };\n").diags[0]!;
    expect(keyofT).toMatchObject({ code: "E1000", message: "type operator is not allowed", data: { kind: "type-operator" } });

    const typeofT = checkSrc("const x = 1;\ntype T = typeof x;\n").diags[0]!;
    expect(typeofT).toMatchObject({ code: "E1000", message: "'typeof' type query is not allowed", data: { kind: "type-query" } });

    const idxT = checkSrc("type A = { readonly x: i32 };\ntype X = A[\"x\"];\n").diags[0]!;
    expect(idxT).toMatchObject({ code: "E1000", message: "indexed access types are not allowed", data: { kind: "indexed-access-type" } });
  });

  it("flattens 3-part string concatenation into a single template literal quick fix", () => {
    const src = 'export function joinColon(a: string, b: string): string {\n  return a + ":" + b;\n}\n';
    const { diag, fixed, after } = applyFirstFix(src);
    expect(diag.code).toBe("E2002");
    expect(fixed).toContain("return `${a}:${b}`;");
    expect(after).toEqual([]);

    const nested = 'export function join4(a: string, b: string, c: string): string {\n  return a + (":" + b) + ("-" + c);\n}\n';
    const r2 = applyFirstFix(nested);
    expect(r2.fixed).toContain("return `${a}:${b}-${c}`;");
    expect(r2.after).toEqual([]);
  });

  it("attaches declare 'i' as 'usize' fix on E2002 in checkTo", () => {
    const src = [
      "export function sumVec(v: Array<i32>): i32 {",
      "  let sum: i32 = 0;",
      "  for (let i = 0; i < 10; i += 1) {",
      "    sum += v[i];",
      "  }",
      "  return sum;",
      "}",
      "",
    ].join("\n");
    const { diag, fixed, after } = applyFirstFix(src);
    expect(diag.code).toBe("E2002");
    expect(diag.fixes?.[0]?.title).toBe("declare 'i' as 'usize'");
    expect(fixed).toContain("for (let i: usize = 0;");
    expect(after).toEqual([]);
  });

  it("provides actionable E2001 hints and did-you-mean suggestions", () => {
    const strIdx = checkSrc("export function f(s: string): u16 { return s[0]; }\n").diags[0]!;
    expect(strIdx).toMatchObject({
      code: "E2001",
      message: "'string' cannot be indexed; use 'charCodeAt(i)', 'codePointAt(i)', or 'slice(i, i + 1)'",
      data: { receiver: "string", suggestions: ["charCodeAt", "codePointAt", "slice"] },
    });

    const mapEntries = checkSrc("export function f(m: Map<string, i32>): void { m.entries(); }\n").diags[0]!;
    expect(mapEntries).toMatchObject({
      code: "E2001",
      data: { receiver: "Map<string, i32>", member: "entries", suggestions: ["keys", "values", "forEach"] },
    });
    expect(mapEntries.message).toContain("keys()");
    expect(mapEntries.message).toContain("values()");
    expect(mapEntries.message).toContain("forEach((v, k) => ...)");

    const strReplace = checkSrc('export function f(s: string): string { return s.replace("a", "b"); }\n').diags[0]!;
    expect(strReplace).toMatchObject({ code: "E2001", data: { suggestions: ["replaceAll"] } });
    expect(strReplace.message).toContain("replaceAll");

    const strSub = checkSrc("export function f(s: string): string { return s.substring(0, 1); }\n").diags[0]!;
    expect(strSub).toMatchObject({ code: "E2001", data: { suggestions: ["slice"] } });

    const strCharAt = checkSrc("export function f(s: string): string { return s.charAt(0); }\n").diags[0]!;
    expect(strCharAt).toMatchObject({ code: "E2001", data: { suggestions: ["slice", "charCodeAt"] } });

    const arrAt = checkSrc("export function f(xs: Array<i32>): i32 { return xs.at(0); }\n").diags[0]!;
    expect(arrAt).toMatchObject({ code: "E2001", data: { suggestions: ["[i]", "length"] } });

    const typo = checkSrc("export function f(s: string): string { return s.toUperCase(); }\n").diags[0]!;
    expect(typo.code).toBe("E2001");
    expect(typo.message).toContain("did you mean 'toUpperCase'?");
    expect(typo.data?.suggestions).toEqual(["toUpperCase"]);

    const nsTypo = checkSrc("export function f(x: f64): f64 { return Math.floo(x); }\n").diags[0]!;
    expect(nsTypo.code).toBe("E2001");
    expect(nsTypo.message).toContain("did you mean 'floor'");
    expect(nsTypo.data?.suggestions).toContain("floor");
  });

  it("explains T extends Copy on E3001 for unconstrained type parameters", () => {
    const src = [
      'function consume<T>(x: T): void { "use owned"; }',
      "export function dup<T>(x: T): void {",
      '  "use owned";',
      "  consume(x);",
      "  consume(x);",
      "}",
      "",
    ].join("\n");
    const d = checkSrc(src).diags[0]!;
    expect(d).toMatchObject({
      code: "E3001",
      message: "use of moved value 'x' (type parameter 'T' is move-only unless constrained with 'T extends Copy')",
      data: { variable: "x", typeParam: "T" },
    });
  });

  it("keeps user-facing diagnostics and explain entries free of internal Qxxx, SPEC section refs, and local paths", () => {
    const cases = [
      "export async function f(x: Ref<Vec<i32>>): Promise<void> {}\n",
      "export function f(s: Slice<i32>): void {}\n",
      'export function f(a: Alloc): Array<Vec<i32>> { return [Vec.create<i32>(a, 1)]; }\n',
      'export function f(sys: System): void { sys.spawn.isolate<Vec<i32>, i32>(g); }\nfunction g(p: Port<i32, Vec<i32>>): void {}\n',
      'export function f(sys: System): void { sys.audio.open({ sampleRate: 48000, framesPerCallback: 128 }, "bad", r); }\nfunction r(st: string, out: Mut<Slice<f32>>, frames: usize): void { "use rt"; }\n',
    ];
    for (const src of cases) {
      for (const d of checkSrc(src).diags) {
        expect(d.message).not.toMatch(/Q\d{2,3}/);
        expect(d.message).not.toContain("§");
      }
    }
    const e2001 = explainCode("E2001")!;
    expect(e2001.remediation).not.toContain("docs/SPEC.md");
    expect(e2001.remediation).not.toContain("§12");
  });
});

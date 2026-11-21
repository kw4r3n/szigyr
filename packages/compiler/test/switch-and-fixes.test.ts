import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { check, CLI_NAME, run, type Diagnostic } from "../src/index.ts";
import { num, same, type Type } from "../src/types.ts";

const offset = (src: string, p: { line: number; col: number }): number =>
  src.split("\n").slice(0, p.line - 1).reduce((n, l) => n + l.length + 1, 0) + p.col - 1;

function writeSrc(src: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-swfix-`));
  const file = join(dir, "main.szigyr");
  writeFileSync(file, src);
  return file;
}

function applyFirstFix(src: string): { diag: Diagnostic; fixed: string; after: Diagnostic[] } {
  const file = writeSrc(src);
  const diag = check(file)[0]!;
  const edits = [...diag.fixes![0]!.edits].sort((a, b) => offset(src, b.range.start) - offset(src, a.range.start));
  let fixed = src;
  for (const e of edits) {
    fixed = fixed.slice(0, offset(src, e.range.start)) + e.newText + fixed.slice(offset(src, e.range.end));
  }
  writeFileSync(file, fixed);
  return { diag, fixed, after: check(file) };
}

describe("switch case scoping, fallthrough, numeric conversion fixes, and CStruct equality", () => {
  it("scopes switch cases individually across js, c, and wasm backends and rejects duplicate local in same case", async () => {
    const src = [
      "function pick(k: i32): i32 {",
      '  "use rt";',
      "  switch (k) {",
      "    case 1:",
      "      const v: i32 = 10;",
      "      return v;",
      "    case 2:",
      "      const v: i32 = 20;",
      "      return v;",
      "    default:",
      "      const v: i32 = 30;",
      "      return v;",
      "  }",
      "}",
      "export function main(sys: System): void {",
      "  sys.log.info(`${pick(1)}:${pick(2)}:${pick(9)}`);",
      "}",
      "",
    ].join("\n");
    const file = writeSrc(src);
    expect(check(file)).toEqual([]);
    for (const backend of ["js", "c", "wasm"] as const) {
      const r = await run(file, { backend });
      expect(r.diagnostics).toEqual([]);
      expect(r.stdout.trim()).toBe("10:20:30");
    }

    const dupSame = writeSrc([
      "export function bad(k: string): i32 {",
      "  switch (k) {",
      '    case "a":',
      "      const v = 1;",
      "      const v = 2;",
      "      return v;",
      "    default:",
      "      return 0;",
      "  }",
      "}",
      "",
    ].join("\n"));
    expect(check(dupSame).map((d) => d.code)).toContain("E1000");
  });

  it("rejects implicit non-empty fallthrough with E2002 + add 'break;' fix, while allowing empty grouping and normal last-clause exit", () => {
    const multiLine = [
      "export function f(k: string): i32 {",
      "  let out: i32 = 0;",
      "  switch (k) {",
      '    case "a":',
      "      out = 1;",
      '    case "b":',
      "      out = 2;",
      "      break;",
      "    default:",
      "      out = 3;",
      "  }",
      "  return out;",
      "}",
      "",
    ].join("\n");
    const r1 = applyFirstFix(multiLine);
    expect(r1.diag).toMatchObject({
      code: "E2002",
      message: "switch case cannot fall through; end with 'break' or 'return'",
      data: { kind: "switch-fallthrough" },
    });
    expect(r1.diag.fixes?.[0]?.title).toBe("add 'break;'");
    expect(r1.fixed).toContain("      out = 1;\n      break;");
    expect(r1.after).toEqual([]);

    const singleLine = [
      "export function f(k: string): i32 {",
      "  let out: i32 = 0;",
      "  switch (k) {",
      '    case "a": out = 1;',
      '    case "b": out = 2; break;',
      "    default: out = 3;",
      "  }",
      "  return out;",
      "}",
      "",
    ].join("\n");
    const r2 = applyFirstFix(singleLine);
    expect(r2.diag.code).toBe("E2002");
    expect(r2.diag.data).toEqual({ kind: "switch-fallthrough" });
    expect(r2.fixed).toContain('    case "a": out = 1; break;');
    expect(r2.after).toEqual([]);

    const groupedAndLast = writeSrc([
      'type Tag = { readonly kind: "a"; readonly v: i32 } | { readonly kind: "b"; readonly v: i32 } | { readonly kind: "c"; readonly w: i32 };',
      "export function g(t: Tag): i32 {",
      "  let out: i32 = 0;",
      "  switch (t.kind) {",
      '    case "a":',
      '    case "b":',
      "      out = t.v;",
      "      break;",
      '    case "c":',
      "      out = t.w;",
      "  }",
      "  return out;",
      "}",
      "",
    ].join("\n"));
    expect(check(groupedAndLast)).toEqual([]);
  });

  it("attaches numeric conversion quick fix on general checkTo E2002 mismatches", () => {
    const mathAbs = "export function f(x: f32): f64 { return Math.abs(x); }\n";
    const rAbs = applyFirstFix(mathAbs);
    expect(rAbs.diag.code).toBe("E2002");
    expect(rAbs.diag.fixes?.[0]?.title).toBe("convert to 'f64'");
    expect(rAbs.fixed).toContain("return f64(Math.abs(x));");
    expect(rAbs.after).toEqual([]);

    const mathAbsInt = "export function f(x: i32): f64 { return Math.abs(x); }\n";
    const rAbsInt = applyFirstFix(mathAbsInt);
    expect(rAbsInt.diag.code).toBe("E2002");
    expect(rAbsInt.diag.fixes?.[0]?.title).toBe("convert to 'f64'");
    expect(rAbsInt.fixed).toContain("Math.abs(f64(x))");
    expect(rAbsInt.after).toEqual([]);

    const detSin = 'export function f(x: f32): f64 {\n  "use rt";\n  return DetMath.sin(x);\n}\n';
    const rSin = applyFirstFix(detSin);
    expect(rSin.diag.code).toBe("E2002");
    expect(rSin.diag.fixes?.[0]?.title).toBe("convert to 'f64'");
    expect(rSin.fixed).toContain("DetMath.sin(f64(x))");
    expect(rSin.after).toEqual([]);

    const fnUsize = "function takesUsize(n: usize): usize { return n; }\nexport function f(n: i32): usize { return takesUsize(n); }\n";
    const rUsize = applyFirstFix(fnUsize);
    expect(rUsize.diag.code).toBe("E2002");
    expect(rUsize.diag.fixes?.[0]?.title).toBe("convert to 'usize'");
    expect(rUsize.fixed).toContain("takesUsize(usize(n))");
    expect(rUsize.after).toEqual([]);
  });

  it("compares CStruct fields structurally in same()", () => {
    const base: Type = {
      k: "cstruct",
      name: "Pair",
      spec: "c:test:test.h",
      fields: [
        { name: "x", type: num("i32"), readonly: false },
        { name: "y", type: num("f64"), readonly: true },
      ],
    };
    const identical: Type = {
      k: "cstruct",
      name: "Pair",
      spec: "c:test:test.h",
      fields: [
        { name: "x", type: num("i32"), readonly: false },
        { name: "y", type: num("f64"), readonly: true },
      ],
    };
    const diffType: Type = {
      k: "cstruct",
      name: "Pair",
      spec: "c:test:test.h",
      fields: [
        { name: "x", type: num("i64"), readonly: false },
        { name: "y", type: num("f64"), readonly: true },
      ],
    };
    const diffName: Type = {
      k: "cstruct",
      name: "Pair",
      spec: "c:test:test.h",
      fields: [
        { name: "a", type: num("i32"), readonly: false },
        { name: "y", type: num("f64"), readonly: true },
      ],
    };
    const diffReadonly: Type = {
      k: "cstruct",
      name: "Pair",
      spec: "c:test:test.h",
      fields: [
        { name: "x", type: num("i32"), readonly: true },
        { name: "y", type: num("f64"), readonly: true },
      ],
    };
    const diffLen: Type = {
      k: "cstruct",
      name: "Pair",
      spec: "c:test:test.h",
      fields: [{ name: "x", type: num("i32"), readonly: false }],
    };

    expect(same(base, identical)).toBe(true);
    expect(same(base, diffType)).toBe(false);
    expect(same(base, diffName)).toBe(false);
    expect(same(base, diffReadonly)).toBe(false);
    expect(same(base, diffLen)).toBe(false);
  });
});

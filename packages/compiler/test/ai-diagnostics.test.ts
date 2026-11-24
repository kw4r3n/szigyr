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
    const inc = checkSrc("export function f(n: i32): i32 { const y = n++; return y; }\n").diags[0]!;
    expect(inc).toMatchObject({ code: "E1000", message: "'++' is only allowed as a statement or for-loop incrementor", data: { kind: "inc-dec", op: "++" } });

    const dec = checkSrc("export function f(n: i32): i32 { const y = --n; return y; }\n").diags[0]!;
    expect(dec).toMatchObject({ code: "E1000", message: "'--' is only allowed as a statement or for-loop incrementor", data: { kind: "inc-dec", op: "--" } });

    const emptyTup = checkSrc("type Pair = [];\n").diags[0]!;
    expect(emptyTup).toMatchObject({ code: "E1000", message: "empty tuple types '[]' are not allowed", data: { kind: "empty-tuple" } });

    const regexFlag = checkSrc("export function f(): void { const r = /a/g; }\n").diags[0]!;
    expect(regexFlag).toMatchObject({ code: "E1000", data: { kind: "regex-flag", flags: "g" } });

    const ifaceMixed = checkSrc("interface Foo { readonly x: i32; m(): void; }\n").diags[0]!;
    expect(ifaceMixed).toMatchObject({
      code: "E1000",
      message: "interface cannot mix fields and methods",
      data: { kind: "interface-mixed" },
    });

    const forIn = checkSrc("export function f(xs: Array<i32>): void { for (const k in xs) {} }\n").diags[0]!;
    expect(forIn).toMatchObject({ code: "E1000", message: "'for..in' is not allowed; use 'for..of' or an index loop", data: { kind: "for-in" } });

    const logOrEq = checkSrc("export function f(x: i32): void { x ||= true; }\n").diags[0]!;
    expect(logOrEq).toMatchObject({ code: "E2004", data: { actual: "i32" } });

    const inter = checkSrc("type A = { readonly a: i32 };\ntype B = { readonly b: i32 };\ntype C = A & B;\n").diags[0]!;
    expect(inter).toMatchObject({ code: "E1000", data: { kind: "intersection-type" } });

    const keyofT = checkSrc("type K = keyof { readonly a: i32 };\n").diags[0]!;
    expect(keyofT).toMatchObject({ code: "E1000", message: "type operator is not allowed", data: { kind: "type-operator" } });

    const typeofT = checkSrc("const x = 1;\ntype T = typeof x;\n").diags[0]!;
    expect(typeofT).toMatchObject({ code: "E1000", message: "'typeof' type query is not allowed", data: { kind: "type-query" } });

    const idxT = checkSrc("type A = { readonly x: i32 };\ntype X = A[\"x\"];\n").diags[0]!;
    expect(idxT).toMatchObject({ code: "E1000", message: "indexed access types are not allowed", data: { kind: "indexed-access-type" } });
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

    const strReplace = checkSrc('export function f(s: string): string { return s.replace("a", "b"); }\n').diags[0]!;
    expect(strReplace).toMatchObject({ code: "E2001", data: { suggestions: ["replaceAll"] } });
    expect(strReplace.message).toContain("replaceAll");

    const strSub = checkSrc("export function f(s: string): string { return s.substring(0, 1); }\n").diags[0]!;
    expect(strSub).toMatchObject({ code: "E2001", data: { suggestions: ["slice"] } });

    const strCharAt = checkSrc("export function f(s: string): string { return s.charAt(0); }\n").diags[0]!;
    expect(strCharAt).toMatchObject({ code: "E2001", data: { suggestions: ["slice", "charCodeAt"] } });

    const arrMissing = checkSrc("export function f(xs: Array<i32>): usize { return xs.pus(1); }\n").diags[0]!;
    expect(arrMissing).toMatchObject({ code: "E2001", data: { suggestions: ["push", "pop"] } });

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

  it("emits specific data.kind metadata and deduplicates E4002 local cascade in strict code", () => {
    expect(checkSrc("enum E { A, B }\n").diags[0]).toMatchObject({ code: "E1000", data: { kind: "enum" } });
    expect(checkSrc("export function f(x: i32): void { if (x < 0) throw \"neg\"; }\n").diags[0]).toMatchObject({ code: "E1007", data: { kind: "throw", syntax: "throw" } });
    expect(checkSrc("export function f(x: i32): i32 { try { return x; } catch (e) { return 0; } }\n").diags[0]).toMatchObject({ code: "E1007", data: { kind: "try", syntax: "try" } });
    expect(checkSrc("class A { public m(): void {} }\n").diags[0]).toMatchObject({ code: "E1000", data: { kind: "public-modifier" } });
    expect(checkSrc("class A { get x(): i32 { return 1; } }\n").diags[0]).toMatchObject({ code: "E1000", data: { kind: "class-accessor" } });
    expect(checkSrc("class A { [k: string]: i32; }\n").diags[0]).toMatchObject({ code: "E1000", data: { kind: "index-signature" } });
    expect(checkSrc("export function f(): void { const o = { m(): i32 { return 1; } }; }\n").diags[0]).toMatchObject({ code: "E1000", data: { kind: "object-method" } });
    expect(checkSrc("export function f(xs: Array<i32>): void { \"use owned\"; }\n").diags[0]).toMatchObject({ code: "E4002", data: { kind: "managed-array" } });
    expect(checkSrc("export function f(p: { x: i32; y: i32 }): i32 { \"use owned\"; return p.x + p.y; }\n").diags[0]).toMatchObject({ code: "E4002", data: { kind: "mutable-record" } });
    expect(checkSrc("export function f(): void { \"use owned\"; const g = (x: i32): i32 => x; }\n").diags[0]).toMatchObject({ code: "E4003", data: { kind: "strict-arrow" } });

    const cascade = checkSrc("function f(xs: Array<i32>): usize {\n  \"use owned\";\n  return xs.length + xs.length + xs.length;\n}\n");
    expect(cascade.diags.filter((d) => d.code === "E4002")).toHaveLength(1);
  });

  it("rejects rest/extra-default callbacks on host/builtin APIs while allowing them on user HOFs", () => {
    expect(explainCode("E2002")?.kinds?.["callback-extra-params"]).toBeTruthy();

    // User HOFs still allow contravariant rest & trailing default callbacks
    const userHof = checkSrc([
      "function apply(f: (x: i32) => i32): i32 { return f(1); }",
      "function withDef(x: i32, z: i32 = 5): i32 { return x + z; }",
      "function withRest(...xs: Array<i32>): i32 { return i32(xs.length); }",
      "export function ok(): i32 { return apply(withDef) + apply(withRest); }",
      "",
    ].join("\n"));
    expect(userHof.diags).toEqual([]);

    // Host and special builtin callbacks reject rest and extra defaults
    const badHostCases = [
      "export async function s1(sys: System): Promise<void> { const _ = await sys.net.serve({ host: \"127.0.0.1\", port: 0 }, async (req: HttpServerRequest, z: i32 = 1): Promise<HttpServerResponse> => ({ status: 200, headers: [], body: \"ok\" })); }\n",
      "export async function s2(sys: System): Promise<void> { const _ = await sys.net.serveRaw({ host: \"127.0.0.1\", port: 0 }, async (...xs: Array<HttpServerRequest>): Promise<HttpServerRawResponse> => ({ status: 200, headers: [], body: { kind: \"text\", value: \"ok\" } })); }\n",
      "export function j1(js: Js): JsRef { return js.callback<i32>((r: Result<i32, CastError>, z: i32 = 1): void => {}); }\n",
      "export function j2(js: Js): JsRef { return js.fn((...xs: Array<JsRef>): JsRef => xs[0]); }\n",
      "test(\"t1\", (t: Test) => { t.traps(\"T006\", (...xs: Array<i32>): void => {}); });\n",
      "test(\"t2\", async (t: Test) => { await t.trapsAsync(\"T006\", async (z: i32 = 1): Promise<void> => {}); });\n",
      "export function fp1(fp: FakeProc): void { fp.onRun((req: ProcRequest, z: i32 = 1): Result<ProcOutput, IoError> => Result.err({ code: \"E\", message: \"m\" })); }\n",
      "export function fn1(fn: FakeNet): void { fn.onFetch((...xs: Array<HttpClientRequest>): Result<HttpResponse, IoError> => Result.err({ code: \"E\", message: \"m\" })); }\n",
      "export function oc1(a: Alloc): usize { const c = OwnedCell.create(Vec.create<i32>(a, 1)); return c.withRef((v: Ref<Vec<i32>>, z: i32 = 1): usize => v.length); }\n",
      "export function oc2(a: Alloc): void { const c = OwnedCell.create(Vec.create<i32>(a, 1)); c.withMut((...xs: Array<Mut<Vec<i32>>>): void => {}); }\n",
      "export function r1(a: Alloc): void { using r = Resource.own(Vec.create<i32>(a, 1), (v: Vec<i32>, z: i32 = 1): void => {}); }\n",
      "function dropRest(v: Vec<i32>, ...xs: Array<i32>): void {}\nexport function r2(a: Alloc): void { using r = Resource.own(Vec.create<i32>(a, 1), dropRest); }\n",
      "test(\"bad rest test\", (...t: Array<Test>): void => {});\n",
      "export function ens1(x: i32): i32 { ensures((r: i32, z: i32 = 1): boolean => r > 0); return x; }\n",
      "test(\"fa1\", (t: Test) => { forAll((x: i32 = 1): boolean => x > 0); });\n",
    ];
    for (const src of badHostCases) {
      const ds = checkSrc(src).diags;
      expect(ds.length, src).toBeGreaterThan(0);
      expect(ds[0]!.code, src).toBe("E2002");
      expect(ds[0]!.message).not.toMatch(/Q\d{2,3}/);
      expect(ds[0]!.message).not.toContain("§");
    }
  });

  it("rejects spread arguments in non-rest builtins and new with E2002 spread-non-rest and never emits internal-error-type", () => {
    const spreadCases = [
      "export function f(a: Array<f64>): i32 { return i32(...a); }\n",
      "export function f(n: Array<i32>): i32 { return wrapAdd(...n); }\n",
      "export function f(n: Array<i32>): i32 { return wrapAdd(1, ...n); }\n",
      "export function f(n: Array<i32>): i32 { return rem(...n); }\n",
      "export function f(n: Array<i32>): i32 { return divTrunc(4, ...n); }\n",
      "export function f(s: Array<string>): void { panic(...s); }\n",
      "export function f(a: Array<f64>): Result<i32, CastError> { return cast<i32>(...a); }\n",
      "export function f(a: Array<f64>): f64 { return Math.abs(...a); }\n",
      "export function f(a: Array<f64>): f64 { return Math.abs(-2.0, ...a); }\n",
      "export function f(a: Array<f64>): boolean { return Number.isFinite(...a); }\n",
      "export function f(n: Array<i32>): Result<i32, string> { return Result.ok(...n); }\n",
      "export function f(n: Array<i32>): void { const r = Result.ok(...n); }\n",
      "export function f(a: Alloc, xs: Array<i32>): void { using r = Resource.own(...xs); }\n",
      "export function f(sys: System, xs: Array<i32>): void { sys.spawn.isolate(...xs); }\n",
      "export function f(sys: System, xs: Array<i32>): void { sys.audio.open(...xs); }\n",
      "export function f(s: Array<string>): Map<string, i32> { return new Map<string, i32>(...s); }\n",
      "export function f(s: Array<string>): Set<string> { return new Set<string>(...s); }\n",
      "export function f(s: Array<string>): void { const r = new RegExp(...s); }\n",
    ];
    for (const src of spreadCases) {
      const ds = checkSrc(src).diags;
      expect(ds.length, src).toBeGreaterThan(0);
      expect(ds.some((d) => d.data?.kind === "internal-error-type"), src).toBe(false);
      expect(ds[0]).toMatchObject({ code: "E2002", data: { kind: "spread-non-rest" } });
    }

    // Non-callable targets with spread must not emit internal-error-type
    const nonCallableSpread = [
      "export function f(a: Array<i32>): void { const x: i32 = 1; x(...a); }\n",
      "class C { readonly x: i32 = 1; }\nexport function f(a: Array<i32>): void { C(...a); }\n",
      "export function f(a: Array<i32>): void { const x: i32 = 1; new x(...a); }\n",
    ];
    for (const src of nonCallableSpread) {
      const ds = checkSrc(src).diags;
      expect(ds.length, src).toBeGreaterThan(0);
      expect(ds.some((d) => d.data?.kind === "internal-error-type"), src).toBe(false);
    }

    // Spread in strict/rt builtins reports E4001 (managed-only)
    const strictSpread = [
      "export function f(s: Ref<Slice<f64>>): i32 { \"use owned\"; return i32(...s); }\n",
      "export function f(s: Ref<Slice<f64>>): f64 { \"use owned\"; return Math.abs(...s); }\n",
      "export function f(s: Ref<Slice<i32>>): Result<i32, i32> { \"use owned\"; return Result.ok(...s); }\n",
    ];
    for (const src of strictSpread) {
      const ds = checkSrc(src).diags;
      expect(ds[0]).toMatchObject({ code: "E4001", data: { callerLayer: "strict", calleeLayer: "managed" } });
    }

    // Allowed variadic/rest spreads keep working
    expect(checkSrc("export function f(xs: Array<f64>, ys: Array<i32>): f64 {\n  const a = Math.min(...xs) + Math.max(...xs);\n  const b = ys.splice(0, 1, ...[2, 3]);\n  return a + f64(b.length);\n}\n").diags).toEqual([]);
  });

  it("suppresses E2002/E4002 cascade after destructuring assignment E1000", () => {
    const d4 = checkSrc("export function main(sys: System): void { let a = 0; let b = 0; let c = 0; [a, [b, c]] = [1, [2, 3]]; sys.log.info(`${a}`); }\n").diags;
    expect(d4.map((d) => d.code)).toEqual(["E1000"]);

    const strictArr = checkSrc("export function f(): void {\n  \"use owned\";\n  let a: i32 = 0;\n  let b: i32 = 0;\n  [a, b] = [1, 2];\n}\n").diags;
    expect(strictArr.map((d) => d.code)).toEqual(["E1000"]);

    const objAssign = checkSrc("export function f(): void {\n  let a: i32 = 0;\n  let b: i32 = 0;\n  ({ a, b } = { a: 1, b: 2 });\n}\n").diags;
    expect(objAssign.map((d) => d.code)).toEqual(["E1000"]);
  });

  it("allows void optional calls as statements and rejects them in value positions with E2002", () => {
    const stmtOk = checkSrc([
      "class C { m(): void {} readonly f: (() => void) | null = null; }",
      "export function main(): void {",
      "  const f: (() => void) | null = (): void => {};",
      "  const c: C | null = new C();",
      "  const c0 = new C();",
      "  f?.();",
      "  c0.f?.();",
      "  c?.f?.();",
      "  c?.m();",
      "}",
      "",
    ].join("\n")).diags;
    expect(stmtOk).toEqual([]);

    expect(checkSrc("export function main(): void {\n  const f: (() => void) | null = (): void => {};\n  const r = f?.();\n}\n").diags.map((d) => d.code)).toEqual(["E2002"]);
    expect(checkSrc("export function main(): void {\n  const f: (() => void) | null = (): void => {};\n  const r = f?.() ?? 1;\n}\n").diags.map((d) => d.code)).toEqual(["E2002"]);
    expect(checkSrc("class C { m(): void {} }\nexport function main(): void {\n  const c: C | null = new C();\n  const r = c?.m();\n}\n").diags.map((d) => d.code)).toEqual(["E2002"]);
  });
});

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
      data: { kind: "interface-mixed" },
    });
    expect(ifaceMixed.message).toContain("interface cannot mix fields and methods");
    expect(ifaceMixed.message).toContain("class");

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
    expect(checkSrc("export function f(xs: Array<i32>): void { \"use owned\"; }\n").diags[0]).toMatchObject({ code: "E4002", data: { kind: "managed-array" } });
    expect(checkSrc("export function f(p: { x: i32; y: i32 }): i32 { \"use owned\"; return p.x + p.y; }\n").diags[0]).toMatchObject({ code: "E4002", data: { kind: "mutable-record" } });
    expect(checkSrc("export function f(): void { \"use owned\"; const g = (x: i32): i32 => x; }\n").diags[0]).toMatchObject({ code: "E4003", data: { kind: "strict-arrow" } });

    const cascade = checkSrc("function f(xs: Array<i32>): usize {\n  \"use owned\";\n  return xs.length + xs.length + xs.length;\n}\n");
    expect(cascade.diags.filter((d) => d.code === "E4002")).toHaveLength(1);
  });

  it("rejects rest/extra-default callbacks on both host/builtin APIs and function-typed assignments", () => {
    expect(explainCode("E2002")?.kinds?.["callback-extra-params"]).toBeTruthy();

    // Passing rest/trailing-default functions through user HOFs or other fn types is rejected
    const viaFnTypes = [
      "function apply(f: (x: i32) => i32): i32 { return f(1); }\nfunction withDef(x: i32, z: i32 = 5): i32 { return x + z; }\nexport function f(): i32 { return apply(withDef); }\n",
      "function apply(f: (x: i32) => i32): i32 { return f(1); }\nfunction withRest(...xs: Array<i32>): i32 { return i32(xs.length); }\nexport function f(): i32 { return apply(withRest); }\n",
      "type CB = (x: i32) => i32;\nfunction withDef(x: i32, z: i32 = 5): i32 { return x + z; }\nexport function f(): i32 { const cb: CB = withDef; return cb(1); }\n",
      "type CB = (x: i32) => i32;\nfunction withRest(...xs: Array<i32>): i32 { return i32(xs.length); }\nfunction mk(): CB { return withRest; }\nexport function f(): i32 { return mk()(1); }\n",
      "type CB = (x: i32) => i32;\nfunction withDef(x: i32, z: i32 = 5): i32 { return x + z; }\nexport function f(): i32 { const o: { readonly cb: CB } = { cb: withDef }; return o.cb(1); }\n",
      "type CB = (x: i32) => i32;\nfunction withRest(...xs: Array<i32>): i32 { return i32(xs.length); }\nexport function f(): i32 { const xs: Array<CB> = [withRest]; return xs[0](1); }\n",
      "type CB = (x: i32) => i32;\nfunction withDef(x: i32, z: i32 = 5): i32 { return x + z; }\nclass Box { readonly cb: CB; constructor(cb: CB) { this.cb = cb; } }\nexport function f(): i32 { return new Box(withDef).cb(1); }\n",
      "function applyG<T>(f: (x: T) => T, v: T): T { return f(v); }\nfunction withRest(...xs: Array<i32>): i32 { return i32(xs.length); }\nexport function f(): i32 { return applyG(withRest, 1); }\n",
      "type CB = (x: i32) => i32;\nfunction withRest(...xs: Array<i32>): i32 { return i32(xs.length); }\nexport function f(): i32 { const cb: CB | null = withRest; return cb !== null ? cb(1) : 0; }\n",
    ];
    for (const src of viaFnTypes) {
      const ds = checkSrc(src).diags;
      expect(ds.length, src).toBeGreaterThan(0);
      expect(ds[0]!.code, src).toBe("E2002");
      expect(ds[0]!.data).toMatchObject({ kind: "callback-extra-params" });
    }

    // Explicit arrow wrappers forward the expected arity cleanly
    const wrapped = checkSrc([
      "function apply(f: (x: i32) => i32): i32 { return f(1); }",
      "function withDef(x: i32, z: i32 = 5): i32 { return x + z; }",
      "function withRest(...xs: Array<i32>): i32 { return i32(xs.length); }",
      "export function ok(): i32 { return apply((x: i32): i32 => withDef(x)) + apply((x: i32): i32 => withRest(x)); }",
      "",
    ].join("\n"));
    expect(wrapped.diags).toEqual([]);

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

    // Required-arity widening must reject assigning fewer optional params into more optional params, with distinct show()
    const minArityCases = [
      "function keep(x: i32, d: i32 = 10): i32 { return d; }\nfunction keep2(x: i32, d: i32): i32 { return d; }\nexport function f(): i32 { let h = keep; h = keep2; return h(5); }\n",
      "function keep(x: i32, d: i32 = 10): i32 { return d; }\nfunction keep2(x: i32, d: i32): i32 { return d; }\nexport function f(): i32 { const fs = [keep, keep2]; return fs[1](5); }\n",
      "function keep(x: i32, d: i32 = 10): i32 { return d; }\nfunction keep2(x: i32, d: i32): i32 { return d; }\nexport function f(): i32 { const fs = [keep]; fs.push(keep2); return fs[1](5); }\n",
      "function keep(x: i32, d: i32 = 10): i32 { return d; }\nfunction keep2(x: i32, d: i32): i32 { return d; }\nfunction pick<T>(a: T, b: T, c: boolean): T { return c ? a : b; }\nexport function f(): i32 { const h = pick(keep, keep2, false); return h(5); }\n",
      "function v(x: i32 = 1, ...r: Array<i32>): i32 { return x + i32(r.length); }\nfunction w2(x: i32, ...r: Array<i32>): i32 { return x * 2 + i32(r.length); }\nexport function f(): i32 { let h = v; h = w2; return h(); }\n",
      "function add(x: i32, d: i32): string { return `${d}`; }\nfunction wb(x: i32, d: i32 = 1): string { return `${d}`; }\nexport function f(): string { let a = [wb]; const q: Array<(x: i32, d: i32) => string> = [add]; a = q; return a[0](5); }\n",
      "function keep(x: i32, d: i32 = 10): i32 { return d; }\nfunction keep2(x: i32, d: i32): i32 { return d; }\nexport function f(c: boolean): i32 { const h = (c ? keep : null) ?? keep2; return h(5); }\n",
    ];
    for (const src of minArityCases) {
      const ds = checkSrc(src).diags;
      expect(ds.length, src).toBeGreaterThan(0);
      expect(ds[0]!.code, src).toBe("E2002");
      const m = /expected '([^']+)', got '([^']+)'/.exec(ds[0]!.message);
      expect(m, ds[0]!.message).toBeTruthy();
      expect(m![1], ds[0]!.message).not.toBe(m![2]);
      expect(m![1], ds[0]!.message).toContain("?");
      const data = ds[0]!.data as { expected?: string; actual?: string } | undefined;
      if (data?.expected && data?.actual) expect(data.expected, src).not.toBe(data.actual);
    }
    const condRev = checkSrc("function keep(x: i32, d: i32 = 10): i32 { return d; }\nfunction keep2(x: i32, d: i32): i32 { return d; }\nexport function f(c: boolean): i32 { const h = c ? keep2 : keep; return h(5); }\n").diags;
    expect(condRev.map((d) => d.code)).toEqual(["E2002"]);

    // Reverse assignment and calling joined fn with all required arguments remain valid
    expect(checkSrc("function keep(x: i32, d: i32 = 10): i32 { return d; }\nfunction keep2(x: i32, d: i32): i32 { return d; }\nexport function f(c: boolean): i32 { let h = keep2; h = keep; const g = c ? keep2 : keep; return h(5, 6) + g(5, 6); }\n").diags).toEqual([]);
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

    // While suppressing LHS/literal cascades, destructuring RHS expressions are still type-checked (p13-cascade shape)
    const rhsDiags = checkSrc([
      "function rtf(): i32 { \"use rt\"; return 1; }",
      "export function main(sys: System): void {",
      "  let a: i32 = 0;",
      "  let b: i32 = 0;",
      "  [a, b] = [nope, sys.secret(), rtf() + \"x\"];",
      "  ({ a } = { a: undefinedThing });",
      "  sys.log.info(`${a}${b}`);",
      "}",
      "",
    ].join("\n")).diags;
    expect(rhsDiags.map((d) => d.code)).toEqual(["E1000", "E1000", "E2000", "E2001", "E2002", "E2000"]);
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

  it("rejects unsigned integer comparisons with literal 0 that are constant by type (Q319)", () => {
    for (const ty of ["u8", "u16", "u32", "u64", "usize"]) {
      const ge = checkSrc(`export function f(n: ${ty}): boolean { return n >= 0; }\n`).diags;
      expect(ge).toHaveLength(1);
      expect(ge[0]).toMatchObject({ code: "E2002", data: { kind: "unsigned-compare-zero", type: ty, always: true } });
      expect(ge[0]!.message).toContain("for (let i = n; i > 0; i--)");

      const lt = checkSrc(`export function f(n: ${ty}): boolean { return n < -0; }\n`).diags;
      expect(lt[0]).toMatchObject({ code: "E2002", data: { kind: "unsigned-compare-zero", type: ty, always: false } });
    }
    expect(checkSrc("export function f(n: usize): boolean { return (-0) <= n && 0 > n; }\n").diags.map((d) => d.data)).toEqual([
      { kind: "unsigned-compare-zero", type: "usize", always: true },
      { kind: "unsigned-compare-zero", type: "usize", always: false },
    ]);
    expect(explainCode("E2002")?.kinds?.["unsigned-compare-zero"]).toContain("i > 0");
  });

  it("includes replacement hints, data.kind, and safe fixes for common JS/TS mistakes", () => {
    const checkOne = (src: string, code: string, kind: string, hints: string[], hasFix: boolean) => {
      const ds = checkSrc(src).diags;
      const d = ds.find((x) => x.code === code)!;
      expect(d, src).toMatchObject({ code, data: { kind } });
      for (const h of hints) expect(d.message, `${src} -> ${h}`).toContain(h);
      if (hasFix) expect(d.fixes?.length ?? 0, src).toBeGreaterThan(0);
      else expect(d.fixes, src).toBeUndefined();
      return { ds, d };
    };

    checkOne("export function f(x: number): i32 { return x as i32; }\n", "E1005", "as", ["i32(x)", "cast<T>(x)"], false);
    checkOne('export function f(): Array<string> { const y = ["a", "b"] as const; return y; }\n', "E1005", "as-const", ["readonly"], false);
    checkOne("export function f(v: Array<number>): string { return `${v.find((n) => n > 1)}`; }\n", "E2002", "template-nullable", ["!== null", "??"], false);
    checkOne('export function f(m: Map<string, number>, k: string): string { return `${m.get(k)}`; }\n', "E2002", "template-nullable", ["!== null", "??"], false);
    checkOne('export function f(s: string): string { return `${s.indexOf("a")}`; }\n', "E2002", "template-nullable", ["!== null", "??"], false);

    checkOne("export function f(): number { return NaN; }\n", "E2000", "js-global", ["Number.NaN"], true);
    checkOne("export function f(): number { return Infinity; }\n", "E2000", "js-global", ["Number.POSITIVE_INFINITY"], true);
    checkOne("export function f(x: number): boolean { return isNaN(x); }\n", "E2000", "js-global", ["Number.isNaN(x)"], true);
    checkOne("export function f(s: string): number { return parseFloat(s); }\n", "E2000", "js-global", ["Number.parseFloat(s)"], true);
    checkOne("export function f(x: number | null): boolean { return x === undefined; }\n", "E2000", "js-global", ["null"], true);
    checkOne("export function f(x: number | undefined): i32 { return x === null ? 0 : 1; }\n", "E2000", "js-global", ["null"], true);
    checkOne("export function f(s: string): i32 { return parseInt(s, 10); }\n", "E2000", "js-global", ["Number.parseI32(s)", "Result"], false);
    checkOne("export function f(s: string): number { return Number(s); }\n", "E2000", "js-global", ["Number.parseFloat(s)", "f64(x)"], false);
    checkOne("export function f(r: Map<string, number>): Array<string> { return Object.keys(r); }\n", "E2000", "js-global", ["Map<K, V>"], false);
    checkOne("export function f(xs: Array<number>): Array<number> { return Array.from(xs); }\n", "E2000", "js-global", ["[...xs]"], false);

    const mathVal = checkSrc("export function f(): number { return Math; }\n").diags[0]!;
    expect(mathVal).toMatchObject({ code: "E2000", data: { name: "Math" } });
    expect(mathVal.data?.kind).toBeUndefined();

    checkOne("export function f(s: string): i32 { if (s) return 1; return 0; }\n", "E2004", "truthiness", ['!== ""'], true);
    checkOne("export function f(i: i32): i32 { if (i) return 1; return 0; }\n", "E2004", "truthiness", ["!== 0"], true);
    checkOne("export function f(n: number): i32 { if (n) return 1; return 0; }\n", "E2004", "truthiness", ["!== 0", "NaN"], false);
    checkOne("export function f(s: string): boolean { return !s; }\n", "E2004", "truthiness", ['=== ""'], true);
    checkOne("export function f(i: i32): boolean { return !i; }\n", "E2004", "truthiness", ["=== 0"], true);
    checkOne("export function f(n: number): boolean { return !n; }\n", "E2004", "truthiness", ["=== 0", "NaN"], false);
    expect(applyFirstFix("export function f(i: i32): boolean { return !i === false; }\n").fixed).toContain("(i === 0) === false");

    const orNum = checkOne("export function f(a: number, b: number): number { return a || b; }\n", "E2004", "truthiness", ["??", "T | null"], false);
    expect(orNum.ds.map((d) => d.code)).toEqual(["E2004", "E2004", "E2002"]);

    checkOne("export function f(r: Record<string, number>): i32 { return 1; }\n", "E1000", "utility-type", ["Map<K, V>"], false);
    checkOne("type T = { readonly a: number }; export function f(r: Partial<T>): i32 { return 1; }\n", "E1000", "utility-type", ["T | null"], false);
    checkOne("type T = { a: number }; export function f(r: Readonly<T>): i32 { return 1; }\n", "E1000", "utility-type", ["readonly"], false);
    checkOne('type T = { a: number; b: number }; export function f(r: Pick<T, "a">): i32 { return 1; }\n', "E1000", "utility-type", ["record"], false);
    checkOne('type T = { a: number; b: number }; export function f(r: Omit<T, "b">): i32 { return 1; }\n', "E1000", "utility-type", ["'Omit'"], false);

    checkOne("class A { x: i32 = 1; } class B extends A {}\n", "E1000", "class-extends", ["implements"], false);
    checkOne('export function f(x: unknown): boolean { return typeof x === "string"; }\n', "E1000", "typeof", [".kind", "cast<T>(x)"], false);
    checkOne("class C { x: i32 = 1; } export function f(x: unknown): boolean { return x instanceof C; }\n", "E1000", "instanceof", [".kind ==="], false);
    checkOne("export function f(n: number): number { return +n; }\n", "E1000", "unary-operator", ["Number.parseFloat(s)"], false);
    checkOne("export function f(): i32 { let x: i32; x = 1; return x; }\n", "E1000", "no-initializer", ["initialize"], false);
    checkOne("type D = 1 | 2 | 3;\n", "E1000", "literal-type", ["i32", "requires"], false);
    checkOne("export function f<T = number>(x: T): T { return x; }\n", "E1000", "type-param-default", ["explicitly"], false);
    checkOne("export function f(s: string): i32 { let n: i32 = 0; for (const ch of s) { n += 1; } return n; }\n", "E2002", "iterate-string", ["s.charCodeAt(i)", "s.codePointAt(i)"], false);
    checkOne("export function f(a: Array<i32>, b: Array<i32>): boolean { return a === b; }\n", "E2002", "compare-structural", ["t.eq(a, b)"], false);
    checkOne("type R = { a: i32 }; export function f(a: R, b: R): boolean { return a === b; }\n", "E2002", "compare-structural", ["t.eq(a, b)"], false);

    for (const [code, ks] of [
      ["E1000", ["utility-type", "no-initializer", "literal-type", "type-param-default"]],
      ["E1005", ["as", "as-const"]],
      ["E2000", ["js-global", "use-before-declaration"]],
      ["E2002", ["template-nullable", "iterate-string", "compare-structural"]],
      ["E2004", ["truthiness"]],
    ] as const) {
      for (const k of ks) {
        const msg = explainCode(code)?.kinds?.[k] ?? "";
        expect(msg.length, `${code}.${k}`).toBeGreaterThan(0);
        expect(msg).not.toMatch(/§|SPEC|Q\d{2,3}|use strict|\b(Eq|Hash|Ord)\b/);
      }
    }
  });

  it("reports builtinKind and a rename hint on reserved-name declarations without fixes", () => {
    const cases = [
      ["class Ring { x: i32 = 1; }\n", "Ring", "namespace"],
      ["class Result { x: i32 = 1; }\n", "Result", "type"],
      ["export function panic(): i32 { return 1; }\n", "panic", "function"],
      ["type Copy = { x: i32 };\n", "Copy", "capability"],
    ] as const;
    for (const [src, name, builtinKind] of cases) {
      const d = checkSrc(src).diags[0]!;
      expect(d, src).toMatchObject({ code: "E1000", data: { kind: "reserved-name", name, builtinKind } });
      expect(d.message).toContain(builtinKind);
      expect(d.message.toLowerCase()).toContain("rename");
      expect(d.fixes).toBeUndefined();
    }
  });

  it("rejects use before declaration within blocks with E2000 use-before-declaration across all value, type, and using paths (Q322)", () => {
    const assertUbd = (src: string, name: string, declLine: number) => {
      const ds = checkSrc(src).diags;
      expect(ds.length, src).toBeGreaterThan(0);
      expect(ds[0], src).toMatchObject({ code: "E2000", data: { kind: "use-before-declaration", name } });
      expect(ds[0]!.message, src).toContain(`line ${declLine}`);
      expect(ds[0]!.message, src).toContain("move the declaration above this use");
      expect(ds[0]!.fixes, src).toBeUndefined();
    };

    // n6: no outer binding -> upgraded from unknown name to use-before-declaration
    assertUbd([
      "export function main(sys: System): void {",
      "  function g(): i32 { return k; }",
      "  const k: i32 = 3;",
      "  sys.log.info(`${g()}`);",
      "}",
      "",
    ].join("\n"), "k", 3);

    // lvalue, compound assignment, and incDec
    assertUbd("export function f(): void {\n  let x: i32 = 1;\n  {\n    x = 2;\n    let x: i32 = 3;\n  }\n}\n", "x", 5);
    assertUbd("export function f(): void {\n  let x: i32 = 1;\n  {\n    x += 1;\n    let x: i32 = 3;\n  }\n}\n", "x", 5);
    assertUbd("export function f(): void {\n  let x: i32 = 1;\n  {\n    x++;\n    let x: i32 = 3;\n  }\n}\n", "x", 5);

    // special-form value paths: fnArgRef, fuzzContracts, forAll, Resource.own, spawn.isolate, audio.open, cfn, newExpr, static member, switch case
    assertUbd([
      'function dbl(x: i32): i32 { "use owned"; return x * 2; }',
      'function apply(f: (x: i32) => i32, v: i32): i32 { "use owned"; return f(v); }',
      "export function main(): i32 {",
      "  const r = apply(dbl, 3);",
      "  const dbl: i32 = 9;",
      "  return r + dbl;",
      "}",
      "",
    ].join("\n"), "dbl", 5);
    assertUbd([
      "function id(x: i32): i32 { requires(x >= 0); return x; }",
      'test("fuzz", (t: Test) => {',
      "  fuzzContracts(id);",
      "  const id: i32 = 1;",
      "  t.eq(id, 1);",
      "});",
      "",
    ].join("\n"), "id", 4);
    assertUbd([
      "function id(x: i32): boolean { return x >= 0; }",
      'test("fa", (t: Test) => {',
      "  forAll(id);",
      "  const id: i32 = 1;",
      "  t.eq(id, 1);",
      "});",
      "",
    ].join("\n"), "id", 4);
    assertUbd([
      'function dropV(v: Vec<i32>): void { "use owned"; }',
      "export function f(a: Alloc): i32 {",
      "  using r = Resource.own(Vec.create<i32>(a, 1), dropV);",
      "  const dropV: i32 = 1;",
      "  return dropV;",
      "}",
      "",
    ].join("\n"), "dropV", 4);
    assertUbd([
      'function dropV(v: Vec<i32>): void { "use owned"; }',
      "export function f(a: Alloc): void {",
      "  using dropV = Resource.own(Vec.create<i32>(a, 1), dropV);",
      "}",
      "",
    ].join("\n"), "dropV", 3);
    assertUbd([
      "function worker(p: Port<i32, i32>): void {}",
      "export function main(sys: System): i32 {",
      "  const p = sys.spawn.isolate(worker);",
      "  const worker: i32 = 1;",
      "  p.close();",
      "  return worker;",
      "}",
      "",
    ].join("\n"), "worker", 4);
    assertUbd([
      'function render(st: i32, out: Mut<Slice<f32>>, frames: usize): void { "use rt"; }',
      "export async function main(sys: System): Promise<i32> {",
      "  const s = await sys.audio.open({ sampleRate: 48000, channels: 2 }, 0, render);",
      "  const render: i32 = 1;",
      "  return render;",
      "}",
      "",
    ].join("\n"), "render", 4);
    assertUbd([
      'function cb(x: i32): i32 { "use rt"; return x; }',
      "export function f(): void {",
      '  "use owned"; "use unsafe";',
      "  const p = cfn(cb);",
      "  const cb: i32 = 1;",
      "}",
      "",
    ].join("\n"), "cb", 5);
    assertUbd([
      "class Box { static readonly V: i32 = 1; }",
      "export function f(): i32 {",
      "  const a = Box.V;",
      "  const Box: i32 = 2;",
      "  return a + Box;",
      "}",
      "",
    ].join("\n"), "Box", 4);
    assertUbd([
      "const TAG: i32 = 1;",
      "export function f(x: i32): i32 {",
      "  switch (x) {",
      "    case TAG: return 1;",
      "    default: return 0;",
      "  }",
      "  const TAG: i32 = 2;",
      "}",
      "",
    ].join("\n"), "TAG", 7);

    // non-Checker.typeOf type paths: localTypeAlias (aliasBody), nestedFn & checkArrow constraints (resolveConstraint)
    assertUbd([
      "export function f(): void {",
      "  type P = i32;",
      "  {",
      "    type A = P;",
      "    type P = string;",
      "  }",
      "}",
      "",
    ].join("\n"), "P", 5);
    assertUbd([
      "export function f(): void {",
      "  type P = i32;",
      "  {",
      "    function g<T extends P>(x: T): T { return x; }",
      "    type P = string;",
      "  }",
      "}",
      "",
    ].join("\n"), "P", 5);
    assertUbd([
      "export function f(): void {",
      "  const g = <T extends P>(x: T): T => x;",
      "  type P = i32;",
      "}",
      "",
    ].join("\n"), "P", 3);

    // using & await using self-ref in initializer
    assertUbd([
      "class D implements Disposable { readonly id: i32; constructor(id: i32) { this.id = id; } dispose(): void {} }",
      "function wrap(d: D): D { return new D(d.id + 1); }",
      "export function f(): i32 {",
      "  const r = new D(1);",
      "  {",
      "    using r = wrap(r);",
      "    return r.id;",
      "  }",
      "}",
      "",
    ].join("\n"), "r", 6);
    assertUbd([
      "class AD implements AsyncDisposable { readonly id: i32; constructor(id: i32) { this.id = id; } async disposeAsync(): Promise<void> {} }",
      "async function mk(d: AD): Promise<AD> { return new AD(d.id + 1); }",
      "export async function f(): Promise<i32> {",
      "  const r = new AD(1);",
      "  {",
      "    await using r = await mk(r);",
      "    return r.id;",
      "  }",
      "}",
      "",
    ].join("\n"), "r", 6);

    // multi-declarator, destructuring, for..of destructuring, contracts, default param TDZ
    assertUbd("export function f(): i32 {\n  const b: i32 = 1;\n  {\n    const a: i32 = 1, b: i32 = b + 1;\n    return a + b;\n  }\n}\n", "b", 4);
    assertUbd("export function f(): i32 {\n  const a: i32 = 1;\n  {\n    const { a }: { readonly a: i32 } = { a };\n    return a;\n  }\n}\n", "a", 4);
    assertUbd("export function f(): i32 {\n  const a: Array<[i32, i32]> = [[1, 2]];\n  let s: i32 = 0;\n  for (const [a, b] of a) { s += a + b; }\n  return s;\n}\n", "a", 4);
    assertUbd("export function f(x: i32): i32 {\n  requires(x > k);\n  const k: i32 = 0;\n  return x + k;\n}\n", "k", 3);
    assertUbd("const x: i32 = 1;\nexport function f(x: i32 = x): i32 { return x; }\n", "x", 2);

    // Own type parameter shadowing a later local type in the enclosing block stays valid
    expect(checkSrc([
      "export function f(): i32 {",
      "  type A<P> = { readonly v: P };",
      "  function g<P>(x: P): P { return x; }",
      "  const h = <P>(x: P): P => x;",
      "  const a: A<i32> = { v: g<i32>(1) + h<i32>(2) };",
      "  type P = string;",
      "  const s: P = \"ok\";",
      "  return a.v + i32(s.length);",
      "}",
      "",
    ].join("\n")).diags).toEqual([]);
  });
});

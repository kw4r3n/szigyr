// D132: the builtin effect table is complete and its by-name readings agree with its per-type entries.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BUILTIN_FUNCTIONS, BUILTIN_NAMES, NONDET_GEN, NONDET_OPAQUE, SPEC_RESERVED, builtinMethods, NAMESPACES } from "../src/builtins.ts";
import { check } from "../src/index.ts";
import { isDeterministic } from "../src/determinism.ts";
import { AUTHORITIES, F64, GEN_ARITY, NUM_NAMES, OPAQUE_NAMES, VOID, gen, opaque, type GenName, type Type } from "../src/types.ts";

const methods = builtinMethods();

it("declares every effect field for every builtin method", () => {
  expect(methods.length).toBeGreaterThan(100);
  for (const { owner, name, fx } of methods) {
    const where = `${owner} ${name}`;
    expect(["ref", "mut", "param", "none"], where).toContain(fx.recv);
    expect(typeof fx.mutates, where).toBe("boolean");
    expect(typeof fx.contract, where).toBe("boolean");
    expect(Array.isArray(fx.traps) && fx.traps.every((c) => /^T\d{3}$/.test(c)), where).toBe(true);
    if (fx.recv === "mut") expect(fx.mutates, where).toBe(true);
    if (!fx.mutates) expect(fx.contract, where).toBe(true);
  }
});

it("lets no method that changes state be called inside a contract (Q134, Q230 (a))", () => {
  const open = methods.filter((x) => x.fx.mutates && x.fx.contract).map((x) => `${x.owner} ${x.name}`).sort();
  expect(open).toEqual([]);
});

it("gives each method name one contract verdict, so Q134's by-name rule reads the table exactly", () => {
  const verdict = new Map<string, boolean>();
  for (const { owner, name, fx } of methods) {
    expect(verdict.get(name) ?? fx.contract, `${owner} ${name}`).toBe(fx.contract);
    verdict.set(name, fx.contract);
  }
});

it("decides §7.3 determinism for every opaque builtin type", () => {
  expect(Object.keys(NONDET_OPAQUE).sort()).toEqual([...OPAQUE_NAMES].sort());
});

it("documents every builtin global name in SPEC and keeps BUILTIN_NAMES complete (§12, §13)", () => {
  const spec = readFileSync(new URL("../../../docs/SPEC.md", import.meta.url), "utf8");
  const documented = new Set<string>();
  for (const m of spec.matchAll(/`([^`]+)`/g)) {
    for (const id of m[1]!.matchAll(/\b([A-Za-z_]\w*)\b/g)) documented.add(id[1]!);
  }
  if (spec.includes("`i8`..`f64`")) for (const n of NUM_NAMES) documented.add(n);
  if (spec.includes("wrapAdd/Sub/Mul")) for (const n of ["wrapAdd", "wrapSub", "wrapMul"]) documented.add(n);

  for (const name of BUILTIN_NAMES) expect(documented.has(name), name).toBe(true);
  const expected = new Set<string>([
    ...SPEC_RESERVED,
    "boolean", "string", "number", "null", "void", "unknown", "never",
    "Result", "OwnedStruct", "RingPair", "JsError", "CastError", "IoError", "AudioConfig", "DisplayConfig", "DisplayColor", "DisplayEvent",
    "DirEntry", "FileStat", "EnvVar", "ProcOptions", "ProcOutput", "ProcRequest",
    "HttpHeader", "HttpRequestInit", "HttpResponse", "HttpServerConfig", "HttpServerRequest", "HttpServerResponse", "HttpBody", "HttpServerRawResponse", "HttpClientRequest", "QueryParam",
    "RegExpMatch", "Resource", "Disposable", "AsyncDisposable", "CStruct",
    ...Object.keys(GEN_ARITY), ...OPAQUE_NAMES, ...NAMESPACES, ...BUILTIN_FUNCTIONS,
  ]);
  expect([...BUILTIN_NAMES].sort()).toEqual([...expected].sort());
});

it("keeps docs/SPEC.md compact (<= 28 KB) and provides docs/STDLIB.md reference entries", () => {
  const spec = readFileSync(new URL("../../../docs/SPEC.md", import.meta.url), "utf8");
  const stdlib = readFileSync(new URL("../../../docs/STDLIB.md", import.meta.url), "utf8");
  expect(Buffer.byteLength(spec, "utf8")).toBeLessThanOrEqual(28_000);
  for (const key of ["DisplayEvent", "HttpServerRawResponse", "FakeNet", "DetMath", "fromTypedArray"]) {
    expect(stdlib, key).toContain(key);
  }
});

// The expected sets are written out here, not read from the tables, so flipping a table entry fails this test.
const NONDET_GEN_EXPECTED = ["RingTx", "RingRx", "Ptr", "ConstPtr", "CHandle", "Port"];
const NONDET_OPAQUE_EXPECTED = [...AUTHORITIES, "JsRef", "AudioStream", "DisplaySurface", "HttpServer", "FakeClock", "SeededRandom", "MemoryLog", "FakeFs", "FakeSpawn", "FakeAudio", "FakeDisplay", "FakeNet", "FakeProc"];
it("reports a function nondeterministic exactly for the §7.3 builtin types", () => {
  const det = (p: Type): boolean => isDeterministic({ k: "fn", tparams: [], params: [p], ret: VOID });
  const detRet = (r: Type): boolean => isDeterministic({ k: "fn", tparams: [], params: [], ret: r });
  for (const name of Object.keys(NONDET_GEN)) {
    const t = gen(name as GenName, F64);
    expect(det(t), `gen param ${name}`).toBe(!NONDET_GEN_EXPECTED.includes(name));
    expect(detRet(t), `gen ret ${name}`).toBe(!NONDET_GEN_EXPECTED.includes(name));
  }
  for (const name of OPAQUE_NAMES) {
    const t = opaque(name);
    expect(det(t), `opaque param ${name}`).toBe(!NONDET_OPAQUE_EXPECTED.includes(name));
    expect(detRet(t), `opaque ret ${name}`).toBe(!NONDET_OPAQUE_EXPECTED.includes(name));
  }
});

it("reserves the exact names SPEC §13 lists, and treats them like a builtin name (Q231)", () => {
  const spec = readFileSync(new URL("../../../docs/SPEC.md", import.meta.url), "utf8");
  const sec13 = spec.slice(spec.indexOf("## 13."));
  const resLine = sec13.split("\n").find((l) => l.startsWith("- **Reserved")) ?? "";
  const afterColon = resLine.slice(resLine.indexOf("**:") + 3);
  const specRes = [...afterColon.matchAll(/`([A-Za-z_]\w*)`/g)].map((m) => m[1]!);
  expect([...specRes].sort()).toEqual([...SPEC_RESERVED].sort());
  for (const n of specRes) expect(BUILTIN_NAMES.has(n), n).toBe(true);
});

it("treats a reserved §13 name exactly like a builtin name in every declaration form (Q231)", () => {
  const forms: Record<string, (n: string) => string> = {
    type: (n) => `type ${n} = { readonly x: i32 };\n`,
    function: (n) => `function ${n}(): void {}\n`,
    class: (n) => `class ${n} { readonly x: i32 = 0; }\n`,
    const: (n) => `const ${n}: i32 = 1;\n`,
    param: (n) => `function f(${n}: i32): void {}\n`,
    local: (n) => `function f(): void { const ${n}: i32 = 1; }\n`,
    interface: (n) => `interface ${n} { m(): void; }\n`,
    field: (n) => `type R = { readonly ${n}: i32 };\n`, // a property name is not a global: allowed for both
    typeParam: (n) => `function f<${n}>(x: i32): void {}\n`,
  };
  const dir = mkdtempSync(join(tmpdir(), "szigyr-q231-"));
  const codes = (src: string): string => {
    const f = join(dir, "f.szigyr");
    writeFileSync(f, src);
    return check(f).map((d) => `${d.code}@${d.range.start.line}`).join(",");
  };
  for (const [form, src] of Object.entries(forms)) {
    const want = codes(src("panic"));
    for (const n of SPEC_RESERVED) expect(codes(src(n)), `${form} ${n}`).toBe(want);
  }
}, 60_000);

it("registers forAll and fuzzContracts as builtin functions rather than reserved (§12, §16.1)", () => {
  expect(BUILTIN_FUNCTIONS.has("forAll")).toBe(true);
  expect(BUILTIN_FUNCTIONS.has("fuzzContracts")).toBe(true);
  expect(SPEC_RESERVED).not.toContain("forAll");
  expect(SPEC_RESERVED).not.toContain("fuzzContracts");
  expect(BUILTIN_NAMES.has("forAll")).toBe(true);
  expect(BUILTIN_NAMES.has("fuzzContracts")).toBe(true);
});

it("enforces Group A TS-divergence cleanups (Result.ok/err, field-only interface, no satisfies, borrowSlice, OwnedStruct)", () => {
  const dir = mkdtempSync(join(tmpdir(), "szigyr-group-a-"));
  const checkSrc = (name: string, src: string) => {
    const f = join(dir, name);
    writeFileSync(f, src);
    return check(f);
  };
  expect(checkSrc("free-ok-err.szigyr", `export function f(ok: i32, err: string): i32 { const r: Result<i32, string> = ok > 0 ? Result.ok(ok) : Result.err(err); return r.kind === "ok" ? r.value : 0; }\n`)).toEqual([]);
  expect(checkSrc("rec-iface.szigyr", `export interface Base { readonly x: i32; }\nexport interface Pt extends Base { readonly y: i32; }\nexport function sum(p: Pt): i32 { return p.x + p.y; }\n`)).toEqual([]);
  const hint = (src: string, file: string) => checkSrc(file, src).map((d) => `${d.code}:${d.message}`);
  expect(hint(`export function f(): void { const x = ok(1); }\n`, "unbound-ok.szigyr")[0]).toMatch(/^E2000:.*Result\.ok/);
  expect(hint(`export function f(): void { const x = err("a"); }\n`, "unbound-err.szigyr")[0]).toMatch(/^E2000:.*Result\.err/);
  expect(hint(`export type R = Struct<{ readonly x: i32 }>;\n`, "unbound-struct.szigyr")[0]).toMatch(/^E2000:.*OwnedStruct/);
  expect(hint(`interface A { m(): void; }\ninterface B extends A { n(): void; }\n`, "iface-ext.szigyr")[0]).toMatch(/^E1000:/);
  expect(hint(`export function f(): i32 { return 1 satisfies i32; }\n`, "satisfies.szigyr")[0]).toMatch(/^E1000:/);
  expect(hint(`function take(s: Ref<Slice<i32>>): usize { return s.length; }\nexport function f(a: Alloc): usize { const v = Vec.create<i32>(a, 4); return take(v.slice(0, 1)); }\n`, "vec-slice.szigyr")[0]).toMatch(/^E2001:.*borrowSlice/);
  expect(hint(`function take(s: Ref<Slice<i32>>): usize { return s.slice(0, 1).length; }\n`, "slice-slice.szigyr")[0]).toMatch(/^E2001:.*borrowSlice/);
  const ownedRec = checkSrc("owned-struct.szigyr", `type Box = OwnedStruct<{ readonly x: i32 }>;\nfunction consume(b: Box): i32 { return b.x; }\nexport function f(): i32 { const b: Box = { x: 1 }; consume(b); return b.x; }\nexport function bad(u: unknown): Result<Box, CastError> { return cast<Box>(u); }\n`);
  expect(ownedRec.map((d) => d.code)).toEqual(["E2002", "E3001"]);
}, 60_000);

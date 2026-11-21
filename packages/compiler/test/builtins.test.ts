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
    "Result", "Struct", "RingPair", "JsError", "CastError", "IoError", "AudioConfig",
    "DirEntry", "FileStat", "EnvVar", "ProcOptions", "ProcOutput", "ProcRequest",
    "HttpHeader", "HttpRequestInit", "HttpResponse", "HttpServerConfig", "HttpServerRequest", "HttpServerResponse", "HttpClientRequest",
    "Resource", "Disposable", "AsyncDisposable", "CStruct",
    ...Object.keys(GEN_ARITY), ...OPAQUE_NAMES, ...NAMESPACES, ...BUILTIN_FUNCTIONS,
  ]);
  expect([...BUILTIN_NAMES].sort()).toEqual([...expected].sort());
});

// The expected sets are written out here, not read from the tables, so flipping a table entry fails this test.
const NONDET_GEN_EXPECTED = ["RingTx", "RingRx", "Ptr", "ConstPtr", "CHandle", "Port"];
const NONDET_OPAQUE_EXPECTED = [...AUTHORITIES, "JsRef", "AudioStream", "HttpServer", "FakeClock", "SeededRandom", "MemoryLog", "FakeFs", "FakeSpawn", "FakeAudio", "FakeNet", "FakeProc"];
it("reports a function nondeterministic exactly for the §7.3 builtin types", () => {
  const det = (p: Type): boolean => isDeterministic({ k: "fn", tparams: [], params: [p], ret: VOID });
  for (const name of Object.keys(NONDET_GEN)) expect(det(gen(name as GenName, F64)), `gen ${name}`).toBe(!NONDET_GEN_EXPECTED.includes(name));
  for (const name of OPAQUE_NAMES) expect(det(opaque(name)), `opaque ${name}`).toBe(!NONDET_OPAQUE_EXPECTED.includes(name));
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
    const want = codes(src("ok"));
    for (const n of SPEC_RESERVED) expect(codes(src(n)), `${form} ${n}`).toBe(want);
  }
}, 60_000);

it("registers forAll as a builtin function rather than reserved (§12, §16.1)", () => {
  expect(BUILTIN_FUNCTIONS.has("forAll")).toBe(true);
  expect(SPEC_RESERVED).not.toContain("forAll");
  expect(BUILTIN_NAMES.has("forAll")).toBe(true);
});

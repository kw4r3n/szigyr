// D132: the builtin effect table is complete and its by-name readings agree with its per-type entries.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BUILTIN_FUNCTIONS, BUILTIN_NAMES, NONDET_GEN, NONDET_OPAQUE, SPEC_RESERVED, builtinMethods } from "../src/builtins.ts";
import { check } from "../src/index.ts";
import { isDeterministic } from "../src/determinism.ts";
import { AUTHORITIES, F64, OPAQUE_NAMES, VOID, gen, opaque, type GenName, type Type } from "../src/types.ts";

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

it("reserves exactly the global names SPEC §12 and §7.1 list, plus the §13 ones", () => {
  const spec = readFileSync(new URL("../../../docs/SPEC.md", import.meta.url), "utf8");
  const sec = (from: string, to: string): string => { const i = spec.indexOf(from); return spec.slice(i, spec.indexOf(to, i)); };
  const ticks = (s: string): string[] => [...s.matchAll(/`([^`]+)`/g)].map((x) => x[1]!);
  const names = new Set(ticks(sec("### 7.1", "- プログラムの入口"))); // the authority types
  for (const line of sec("## 12.", "## 13.").split("\n")) {
    const whole = /^- \*\*(型|関数|標準ライブラリの偽の権限)\*\*/.test(line); // every name on these lines is global
    for (const t of ticks(line)) {
      if (whole && /^[A-Za-z_]\w*$/.test(t)) names.add(t);
      const ns = /^([A-Z]\w*)\.\w+$/.exec(t); // `Ring.create`, `String.fromCodePoint`
      if (ns) names.add(ns[1]!);
    }
    const head = /^- \*\*`([A-Za-z]\w*)`/.exec(line); // **`Math`**, **`string` のメンバ**
    if (head) names.add(head[1]!);
  }
  for (const n of SPEC_RESERVED) names.add(n); // §13 (below)
  expect([...names].sort()).toEqual([...BUILTIN_NAMES].sort());
});

// The expected sets are written out here, not read from the tables, so flipping a table entry fails this test.
const NONDET_GEN_EXPECTED = ["RingTx", "RingRx", "Ptr", "ConstPtr", "CHandle", "Port"];
const NONDET_OPAQUE_EXPECTED = [...AUTHORITIES, "JsRef", "FakeClock", "SeededRandom", "MemoryLog", "FakeFs"];
it("reports a function nondeterministic exactly for the §7.3 builtin types", () => {
  const det = (p: Type): boolean => isDeterministic({ k: "fn", tparams: [], params: [p], ret: VOID });
  for (const name of Object.keys(NONDET_GEN)) expect(det(gen(name as GenName, F64)), `gen ${name}`).toBe(!NONDET_GEN_EXPECTED.includes(name));
  for (const name of OPAQUE_NAMES) expect(det(opaque(name)), `opaque ${name}`).toBe(!NONDET_OPAQUE_EXPECTED.includes(name));
});

it("reserves the names SPEC §13 lists, and declares them like a builtin name (Q231)", () => {
  const spec = readFileSync(new URL("../../../docs/SPEC.md", import.meta.url), "utf8");
  const i = spec.indexOf("## 13.");
  const sec13 = spec.slice(i, spec.indexOf("## 14.", i));
  const heads = [...sec13.matchAll(/`([A-Za-z_]\w*)[^`]*`/g)].map((x) => x[1]!);
  const notNames = ["char", "extends"]; // a C type and a keyword, not names a program declares
  for (const h of heads) expect(BUILTIN_NAMES.has(h) || notNames.includes(h), h).toBe(true);
  for (const n of SPEC_RESERVED) expect(heads.includes(n) || n === "bigint" || n === "undefined", n).toBe(true);
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
  const dir = mkdtempSync(join(tmpdir(), "sts-q231-"));
  const codes = (src: string): string => {
    const f = join(dir, "f.ts");
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

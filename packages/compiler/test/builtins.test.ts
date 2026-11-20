// D132: the builtin effect table is complete and its by-name readings agree with its per-type entries.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { BUILTIN_NAMES, builtinMethods } from "../src/builtins.ts";

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

it("lets only the Q230 methods change state inside a contract", () => {
  const open = methods.filter((x) => x.fx.mutates && x.fx.contract).map((x) => `${x.owner} ${x.name}`).sort();
  expect(open).toEqual(["Port close", "Port recv", "Port send", "Spawn isolate"]);
});

it("gives each method name one contract verdict, so Q134's by-name rule reads the table exactly", () => {
  const verdict = new Map<string, boolean>();
  for (const { owner, name, fx } of methods) {
    expect(verdict.get(name) ?? fx.contract, `${owner} ${name}`).toBe(fx.contract);
    verdict.set(name, fx.contract);
  }
});

it("reserves exactly the global names SPEC §12 and §7.1 list", () => {
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
  expect([...names].sort()).toEqual([...BUILTIN_NAMES].sort());
});

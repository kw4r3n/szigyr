import { fileURLToPath } from "node:url";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Diagnostic, RunResult } from "../src/diagnostics.ts";
import { cPackages, filterByStage, loadCases, missingCPackages, parseCase, parseStage, passingRemovals, pkgExists, runCase, type CaseSpec, type Compiler } from "./harness.ts";

const fx = (p: string) => fileURLToPath(new URL(`./fixtures/${p}`, import.meta.url));
const diag = (code: string, line: number, col: number): Diagnostic => ({
  code, severity: "error", message: "", file: "f",
  range: { start: { line, col }, end: { line, col: col + 1 } },
});
const fake = (check: Diagnostic[], run: Partial<RunResult> = {}): Compiler => ({
  check: () => check,
  run: async () => ({ diagnostics: [], stdout: "", trap: null, ...run }),
});
const byName = (n: string) => loadCases(fx("good")).find((c) => c.name === n)!;

describe("header parsing", () => {
  it("loads all good cases incl. directory form", () => {
    expect(loadCases(fx("good")).map((c) => c.name)).toEqual([
      "accept/ok.szigyr", "reject/e4009.szigyr", "reject/rej.szigyr", "run/conly.szigyr", "run/dir", "run/noout.szigyr", "run/out.szigyr", "run/trap.szigyr", "run/traponly.szigyr",
    ]);
  });
  it("parses fields", () => {
    expect(byName("reject/rej.szigyr")).toMatchObject({ kind: "reject", stage: 1, openQuestion: "Q012", at: { code: "E3001", line: 4, col: 5 } });
    expect(byName("run/out.szigyr").output).toEqual(["a", " b"]);
    expect(byName("run/trap.szigyr").trap).toEqual({ code: "T001", line: 5, col: 3 });
    expect(byName("run/noout.szigyr").output).toEqual([]);
    expect(byName("run/dir").entry).toMatch(/dir\/main\.szigyr$/);
    expect(byName("run/conly.szigyr")).toMatchObject({ kind: "run", stage: 3, backend: "c" });
    expect(byName("run/out.szigyr").backend).toBeUndefined();
  });
  it("rejects malformed headers with file:line", () => {
    for (const f of readdirSync(fx("bad"))) {
      expect(() => parseCase(fx(`bad/${f}`)), f).toThrow(/bad\/.*\.szigyr:\d+:/);
    }
  });
  it("rejects a header whose kind differs from its directory", () => {
    expect(() => loadCases(fx("wrongdir"))).toThrow(/under reject/);
  });
});

describe("stage filter", () => {
  it("keeps stage <= N", () => {
    const all = loadCases(fx("good"));
    expect(filterByStage(all, 1).map((c) => c.stage).every((s) => s <= 1)).toBe(true);
    expect(filterByStage(all, 0)).toEqual([]);
    expect(filterByStage(all)).toHaveLength(all.length);
  });
});

describe("runCase", () => {
  it("accept", async () => {
    expect(await runCase(byName("accept/ok.szigyr"), fake([]))).toEqual([]);
    expect(await runCase(byName("accept/ok.szigyr"), fake([diag("E2002", 1, 1)]))).toHaveLength(1);
  });
  it("reject compares code and start of first diagnostic", async () => {
    const c = byName("reject/rej.szigyr");
    expect(await runCase(c, fake([diag("E3001", 4, 5), diag("E9", 5, 1)]))).toEqual([]);
    expect(await runCase(c, fake([diag("E3002", 4, 5)]))).toHaveLength(1);
    expect(await runCase(c, fake([diag("E3001", 4, 6)]))).toHaveLength(1);
    expect(await runCase(c, fake([]))).toHaveLength(1);
  });
  it("reject takes the first diagnostic after sorting by (line, col, code)", async () => {
    expect(await runCase(byName("reject/rej.szigyr"), fake([diag("E9000", 9, 1), diag("E3001", 4, 5), diag("E2000", 4, 6)]))).toEqual([]);
  });
  it("non-E2009 reject ignores earlier P4 E2009 under all-phase recovery", async () => {
    const c = byName("reject/rej.szigyr");
    expect(await runCase(c, fake([diag("E2009", 3, 16), diag("E3001", 4, 5)]))).toEqual([]);
    expect(await runCase(c, fake([diag("E2009", 3, 16)]))).toHaveLength(1);
  });
  it("run output", async () => {
    const c = byName("run/out.szigyr");
    expect(await runCase(c, fake([], { stdout: "a\n b\n" }))).toEqual([]);
    expect(await runCase(c, fake([], { stdout: "a\n" }))).toHaveLength(1);
    expect(await runCase(c, fake([], { stdout: "a\n b\n", diagnostics: [diag("E1000", 1, 1)] }))).toHaveLength(1);
    expect(await runCase(byName("run/noout.szigyr"), fake([]))).toEqual([]);
    expect(await runCase(byName("run/noout.szigyr"), fake([], { stdout: "x\n" }))).toHaveLength(1);
  });
  it("run trap", async () => {
    const c = byName("run/trap.szigyr");
    const trap = { code: "T001", file: "f", line: 5, col: 3 };
    expect(await runCase(c, fake([], { stdout: "a\n", trap }))).toEqual([]);
    expect(await runCase(c, fake([], { stdout: "a\n", trap: { ...trap, col: 4 } }))).toHaveLength(1);
    expect(await runCase(c, fake([], { stdout: "a\n" }))).toHaveLength(1);
    expect(await runCase(c, fake([], { stdout: "b\n", trap }))).toHaveLength(1);
    expect(await runCase(byName("run/out.szigyr"), fake([], { stdout: "a\n b\n", trap }))).toHaveLength(1);
  });
  it("trap-only case does not compare stdout", async () => {
    const trap = { code: "T002", file: "f", line: 4, col: 1 };
    expect(await runCase(byName("run/traponly.szigyr"), fake([], { stdout: "anything\n", trap }))).toEqual([]);
    expect(await runCase(byName("run/traponly.szigyr"), fake([], { stdout: "x\n" }))).toHaveLength(1);
  });
  it("reject E4009 is read from run's diagnostics, not from check (§14.7)", async () => {
    const c = byName("reject/e4009.szigyr");
    expect(await runCase(c, fake([], { diagnostics: [diag("E4009", 2, 16)] }))).toEqual([]);
    expect(await runCase(c, fake([], { diagnostics: [diag("E4009", 2, 17)] }))).toHaveLength(1);
    expect(await runCase(c, fake([diag("E4009", 2, 16)], { diagnostics: [] }))).toHaveLength(1);
  });
  it("a '// backend: c' run case stops with E4009 on the JS backend and runs on the C backend", async () => {
    const c = byName("run/conly.szigyr");
    expect(await runCase(c, fake([], { diagnostics: [diag("E4009", 1, 1)] }))).toEqual([]);
    expect(await runCase(c, fake([], { stdout: "7\n" }))).toHaveLength(2); // no E4009 stop, and stdout appeared
    expect(await runCase(c, fake([], { diagnostics: [diag("E4009", 1, 1)], stdout: "x\n" }))).toHaveLength(1);
    const cfake: Compiler = { ...fake([], { stdout: "7\n" }), backend: "c" };
    expect(await runCase(c, cfake)).toEqual([]);
    expect(await runCase(c, { ...fake([], { diagnostics: [diag("E4009", 1, 1)] }), backend: "c" })).toHaveLength(2); // the diagnostic, and no output
  });
  it("reports a throwing compiler as a failure", async () => {
    const boom: Compiler = { check: () => { throw new Error("x"); }, run: async () => { throw new Error("y"); } };
    expect(await runCase(byName("accept/ok.szigyr"), boom)).toEqual(["threw Error: x"]);
  });
});

describe("C library skip (§14.7)", () => {
  it("collects the pkg-config packages of a case's c: specifiers", () => {
    const dir = mkdtempSync(join(tmpdir(), "sts-harness-"));
    const f = join(dir, "x.szigyr");
    writeFileSync(f, 'declare module "c:foo:foo.h" {\n}\nimport { g } from "c:bar:bar.h";\nimport { g as g2 } from "c:foo:foo.h";\n');
    const spec: CaseSpec = { name: "run/x.szigyr", kind: "run", entry: f, stage: 3, backend: "c" };
    expect(cPackages(spec)).toEqual(["foo", "bar"]);
    expect(missingCPackages(spec, (p) => p === "foo")).toEqual(["bar"]);
    expect(missingCPackages(spec, () => true)).toEqual([]);
    expect(missingCPackages(spec, () => false)).toEqual(["foo", "bar"]);
  });
  it("a case without c: specifiers needs no library", () => {
    expect(cPackages(byName("run/conly.szigyr"))).toEqual([]);
    expect(missingCPackages(byName("run/conly.szigyr"), () => false)).toEqual([]);
  });
});

it("SZIGYR_STAGE must be a positive integer or unset (D148)", () => {
  expect(parseStage(undefined)).toBeUndefined();
  expect(parseStage("3")).toBe(3);
  for (const bad of ["", "x", "0", "-1", "1.5", " 2"]) expect(() => parseStage(bad)).toThrow(/SZIGYR_STAGE/);
});

it("pkgExists: a missing package is false, a missing pkg-config binary throws (D120)", () => {
  expect(pkgExists("no-such-package-xyz")).toBe(false);
  expect(() => pkgExists("x", "no-such-pkg-config-binary")).toThrow(/not found/);
});

it("passingRemovals names every listed case the new list would drop (D148)", () => {
  expect(passingRemovals(["a", "b", "c"], ["a", "c", "d"])).toEqual(["b"]);
  expect(passingRemovals(["a"], ["a", "b"])).toEqual([]);
});

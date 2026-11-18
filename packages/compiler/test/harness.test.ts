import { fileURLToPath } from "node:url";
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Diagnostic, RunResult } from "../src/diagnostics.ts";
import { filterByStage, loadCases, parseCase, runCase, type Compiler } from "./harness.ts";

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
      "accept/ok.ts", "reject/rej.ts", "run/dir", "run/noout.ts", "run/out.ts", "run/trap.ts",
    ]);
  });
  it("parses fields", () => {
    expect(byName("reject/rej.ts")).toMatchObject({ kind: "reject", stage: 1, openQuestion: "Q012", at: { code: "E3001", line: 4, col: 5 } });
    expect(byName("run/out.ts").output).toEqual(["a", " b"]);
    expect(byName("run/trap.ts").trap).toEqual({ code: "T001", line: 5, col: 3 });
    expect(byName("run/noout.ts").output).toEqual([]);
    expect(byName("run/dir").entry).toMatch(/dir\/main\.ts$/);
  });
  it("rejects malformed headers with file:line", () => {
    for (const f of readdirSync(fx("bad"))) {
      expect(() => parseCase(fx(`bad/${f}`)), f).toThrow(/bad\/.*\.ts:\d+:/);
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
    expect(await runCase(byName("accept/ok.ts"), fake([]))).toEqual([]);
    expect(await runCase(byName("accept/ok.ts"), fake([diag("E2002", 1, 1)]))).toHaveLength(1);
  });
  it("reject compares code and start of first diagnostic", async () => {
    const c = byName("reject/rej.ts");
    expect(await runCase(c, fake([diag("E3001", 4, 5), diag("E9", 1, 1)]))).toEqual([]);
    expect(await runCase(c, fake([diag("E3002", 4, 5)]))).toHaveLength(1);
    expect(await runCase(c, fake([diag("E3001", 4, 6)]))).toHaveLength(1);
    expect(await runCase(c, fake([]))).toHaveLength(1);
  });
  it("run output", async () => {
    const c = byName("run/out.ts");
    expect(await runCase(c, fake([], { stdout: "a\n b\n" }))).toEqual([]);
    expect(await runCase(c, fake([], { stdout: "a\n" }))).toHaveLength(1);
    expect(await runCase(c, fake([], { stdout: "a\n b\n", diagnostics: [diag("E1000", 1, 1)] }))).toHaveLength(1);
    expect(await runCase(byName("run/noout.ts"), fake([]))).toEqual([]);
    expect(await runCase(byName("run/noout.ts"), fake([], { stdout: "x\n" }))).toHaveLength(1);
  });
  it("run trap", async () => {
    const c = byName("run/trap.ts");
    const trap = { code: "T001", file: "f", line: 5, col: 3 };
    expect(await runCase(c, fake([], { stdout: "a\n", trap }))).toEqual([]);
    expect(await runCase(c, fake([], { stdout: "a\n", trap: { ...trap, col: 4 } }))).toHaveLength(1);
    expect(await runCase(c, fake([], { stdout: "a\n" }))).toHaveLength(1);
    expect(await runCase(c, fake([], { stdout: "b\n", trap }))).toHaveLength(1);
    expect(await runCase(byName("run/out.ts"), fake([], { stdout: "a\n b\n", trap }))).toHaveLength(1);
  });
  it("reports a throwing compiler as a failure", async () => {
    const boom: Compiler = { check: () => { throw new Error("x"); }, run: async () => { throw new Error("y"); } };
    expect(await runCase(byName("accept/ok.ts"), boom)).toEqual(["threw Error: x"]);
  });
});

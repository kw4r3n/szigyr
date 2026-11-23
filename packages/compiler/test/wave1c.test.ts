import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  analyze,
  check,
  CLI_NAME,
  createParser,
  mutate,
  prove,
  queryFile,
  rtTrapSites,
  run,
  shutdownSmt,
} from "../src/index.ts";

const tmpRoots: string[] = [];
function makeTmp(prefix = `${CLI_NAME}-w1c-`): { dir: string; cacheFile: string } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return { dir, cacheFile: join(dir, ".szigyr-cache", "prove.json") };
}

function writeTmp(dir: string, rel: string, src: string): string {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, src);
  return p;
}

const parser = createParser();

afterAll(async () => {
  await shutdownSmt();
  parser.close();
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

describe("Wave 1-C interfaces, default params, and constructor parameter properties", () => {
  it("supports queryFile metadata for method-only interfaces and constructor parameter properties, and rejects field/extends interfaces", () => {
    const { dir } = makeTmp();
    const f = writeTmp(
      dir,
      "mod.szigyr",
      [
        `export interface Greeter { greet(name: string): string; }`,
        `export class Box {`,
        `  constructor(private readonly id: i32, public label: string = "a") {}`,
        `  getId(): i32 { return this.id; }`,
        `}`,
        ``,
      ].join("\n"),
    );

    const q = queryFile(f, parser);
    expect(q.diagnostics).toEqual([]);
    const gr = q.symbols.find((s) => s.name === "Greeter");
    expect(gr).toMatchObject({
      name: "Greeter",
      kind: "interface",
      exported: true,
    });
    const box = q.symbols.find((s) => s.name === "Box");
    expect(box).toMatchObject({
      name: "Box",
      kind: "class",
      exported: true,
      fields: [
        { name: "id", type: "i32", readonly: true, private: true, static: false },
        { name: "label", type: "string", readonly: false, private: false, static: false },
      ],
    });

    const badField = writeTmp(dir, "bad_field.szigyr", `export interface Bad { readonly x: i32; }\n`);
    expect(check(badField, parser)).toMatchObject([{ code: "E1000" }]);
    const badExt = writeTmp(dir, "bad_ext.szigyr", `interface A { m(): void; }\ninterface B extends A {}\n`);
    expect(check(badExt, parser)).toMatchObject([{ code: "E1000" }]);
  });

  it("proves contracts through omitted default parameters and checks rt trap sites in defaults", async () => {
    const { dir, cacheFile } = makeTmp();
    const f = writeTmp(
      dir,
      "prove_def.szigyr",
      [
        `function addBound(x: i32, d: i32 = 1): i32 {`,
        `  "use rt";`,
        `  requires(x >= 0 && x <= 100 && d >= 0 && d <= 10);`,
        `  ensures((r) => r >= 0 && r <= 110);`,
        `  return x + d;`,
        `}`,
        `export function caller(a: i32): i32 {`,
        `  "use rt";`,
        `  requires(a >= 0 && a <= 50);`,
        `  return addBound(a);`,
        `}`,
        `export function riskyDefault(x: i32, d: i32 = x + 1): i32 {`,
        `  "use rt";`,
        `  return d;`,
        `}`,
        ``,
      ].join("\n"),
    );

    const sites = rtTrapSites(f);
    expect(sites["riskyDefault"]).toEqual([{ code: "T001", line: 12, col: 49 }]);

    const pr = await prove(f, { cacheFile, parser });
    const callerRes = pr.functions.find((r) => r.fn === "caller");
    const riskyRes = pr.functions.find((r) => r.fn === "riskyDefault");
    expect(callerRes?.summary.proved).toBeGreaterThan(0);
    expect(callerRes?.summary.failed).toBe(0);
    expect(callerRes?.summary.unknown).toBe(0);
    expect(callerRes?.remainingRtTrapSites?.filter((s) => s.code !== "T004")).toEqual([]);
    expect(riskyRes?.summary.failed).toBeGreaterThan(0);
    expect(riskyRes?.remainingRtTrapSites?.length).toBeGreaterThan(0);
  });

  it("runs cross-module strict/rt default params referencing private module constants across JS, C, and Wasm", async () => {
    const { dir } = makeTmp();
    writeTmp(
      dir,
      "lib.szigyr",
      [
        `const SECRET_BIAS: i32 = 100;`,
        `export function rtOffset(x: i32, bias: i32 = SECRET_BIAS): i32 {`,
        `  "use rt";`,
        `  return x + bias;`,
        `}`,
        ``,
      ].join("\n"),
    );
    const main = writeTmp(
      dir,
      "main.szigyr",
      [
        `import { rtOffset } from "./lib.szigyr";`,
        `function callInsideStrict(x: i32): i32 {`,
        `  "use owned";`,
        `  return rtOffset(x);`,
        `}`,
        `export function main(sys: System): void {`,
        `  sys.log.info(\`\${rtOffset(5)}:\${rtOffset(5, 2)}:\${callInsideStrict(8)}\`);`,
        `}`,
        ``,
      ].join("\n"),
    );

    const a = analyze(main, parser);
    expect(a.diagnostics).toEqual([]);
    for (const backend of ["js", "c", "wasm"] as const) {
      const res = await run(main, { backend, analysis: a });
      expect(res.trap, backend).toBeNull();
      expect(res.stdout, backend).toBe("105:7:108\n");
    }
  });

  it("tracks moves inside default parameters (E3001) while allowing non-moving reads", () => {
    const { dir } = makeTmp();
    const bad = writeTmp(
      dir,
      "move_def.szigyr",
      [
        `function take(a: Vec<i32>, b: Vec<i32> = a): usize {`,
        `  "use owned";`,
        `  return a.length + b.length;`,
        `}`,
        ``,
      ].join("\n"),
    );
    const badDiags = check(bad, parser);
    expect(badDiags.some((d) => d.code === "E3001")).toBe(true);

    const good = writeTmp(
      dir,
      "borrow_def.szigyr",
      [
        `function takeLen(a: Vec<i32>, n: usize = a.length): usize {`,
        `  "use owned";`,
        `  return a.length + n;`,
        `}`,
        ``,
      ].join("\n"),
    );
    expect(check(good, parser)).toEqual([]);
  });

  it("supports mutation testing on functions and classes with defaults and parameter properties", async () => {
    const { dir } = makeTmp();
    const f = writeTmp(
      dir,
      "mut_w1c.szigyr",
      [
        `class Acc {`,
        `  constructor(private readonly k: i32, private base: i32 = 2) {}`,
        `  calc(x: i32, bonus: i32 = 5): i32 {`,
        `    return this.k * x + this.base + bonus;`,
        `  }`,
        `}`,
        `export function runCalc(x: i32, extra: i32 = 3): i32 {`,
        `  const a = new Acc(4);`,
        `  return a.calc(x) + extra;`,
        `}`,
        `test("wave1c mutate", (t) => {`,
        `  t.eq(runCalc(2), 18);`,
        `  t.eq(runCalc(2, 1), 16);`,
        `});`,
        ``,
      ].join("\n"),
    );

    const mr = await mutate(f, { parser, cache: false });
    expect(mr.diagnostics).toEqual([]);
    expect(mr.baselineFailure).toBeNull();
    expect(mr.mutants.length).toBeGreaterThan(0);
    expect(mr.summary.survived).toBe(0);
    expect(mr.summary.timeout).toBe(0);
    expect(mr.summary.killed).toBe(mr.mutants.length);
  });
});

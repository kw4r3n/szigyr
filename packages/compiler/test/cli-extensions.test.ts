import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.ts";
import { CLI_NAME } from "../src/names.ts";

const dirs: string[] = [];
function makeDir(tag: string): string {
  const d = mkdtempSync(join(tmpdir(), `${CLI_NAME}-${tag}-`));
  dirs.push(d);
  return d;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function runCli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "", err = "";
  const code = await main(argv, (s) => { out += s; }, (s) => { err += s; });
  return { code, out, err };
}

const jsonLines = (s: string): any[] => s.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

describe("CLI --backend=all", () => {
  it("runs and tests cleanly across js, c, and wasm backends when all agree", async () => {
    const dir = makeDir("all");
    const runFile = join(dir, "app.szigyr");
    writeFileSync(runFile, `function add(a: i32, b: i32): i32 {
  "use rt";
  return a + b;
}
export function main(sys: System): void {
  sys.log.info(\`\${add(20, 22)}\`);
}
`);
    const r = await runCli(["run", "--backend=all", runFile]);
    expect(r).toEqual({ code: 0, out: "42\n", err: "" });

    const testFile = join(dir, "app.test.szigyr");
    writeFileSync(testFile, `function mul(a: i32, b: i32): i32 {
  "use rt";
  return a * b;
}
test("mul works", (t: Test) => {
  t.eq(mul(6, 7), 42);
});
`);
    const t = await runCli(["test", "--json", "--backend=all", testFile]);
    expect(t.code).toBe(0);
    expect(jsonLines(t.out)).toEqual([
      expect.objectContaining({ kind: "test", name: "mul works", ok: true }),
      { kind: "summary", passed: 1, failed: 0 },
    ]);
  });

  it("rejects --backend=all on build --target=node with exit 2", async () => {
    const dir = makeDir("all-build");
    const file = join(dir, "app.szigyr");
    writeFileSync(file, `export function main(sys: System): void { sys.log.info("hi"); }\n`);
    const r = await runCli(["build", "--target=node", "--backend=all", file]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--backend=all");
  });
});

describe("CLI check --fix", () => {
  it("auto-fixes single-edit syntax errors (var, ==) while preserving T[] and for-inc i++", async () => {
    const dir = makeDir("fix-single");
    const fText = join(dir, "single.szigyr");
    const src = `function sum(xs: i32[]): i32 {
  var total: i32 = 0;
  for (let i: usize = 0; i < xs.length; i++) {
    if (xs[i] == 0) { continue; }
    total += xs[i];
  }
  return total;
}
`;
    writeFileSync(fText, src);
    const r = await runCli(["check", "--fix", fText]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`fixed ${fText} (2 edit(s))`);
    const fixed = readFileSync(fText, "utf8");
    expect(fixed).toContain("let total: i32 = 0;");
    expect(fixed).toContain("for (let i: usize = 0; i < xs.length; i++)");
    expect(fixed).toContain("xs[i] === 0");
    expect(await runCli(["check", fText])).toEqual({ code: 0, out: "", err: "" });

    const fJson = join(dir, "single-json.szigyr");
    writeFileSync(fJson, src);
    const rj = await runCli(["check", "--fix", "--json", fJson]);
    expect(rj.code).toBe(0);
    expect(jsonLines(rj.out)).toEqual([{ kind: "fixed", file: fJson, applied: 2 }]);
  });

  it("deduplicates colliding parameter insertion on multi-edit E5001 fixes", async () => {
    const dir = makeDir("fix-e5001");
    const f = join(dir, "log.szigyr");
    writeFileSync(f, `function greet(name: string): void {
  console.log("hello");
  console.log(name);
}
`);
    const r = await runCli(["check", "--fix", f]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`fixed ${f} (3 edit(s))`);
    const updated = readFileSync(f, "utf8");
    expect(updated).toBe(`function greet(name: string, log: Log): void {
  log.info("hello");
  log.info(name);
}
`);
    expect(await runCli(["check", f])).toEqual({ code: 0, out: "", err: "" });
  });

  it("rejects invalid --fix flag combinations with exit 2", async () => {
    const dir = makeDir("fix-bad");
    const f = join(dir, "app.szigyr");
    writeFileSync(f, `export function main(sys: System): void { sys.log.info("ok"); }\n`);
    expect((await runCli(["run", "--fix", f])).code).toBe(2);
    expect((await runCli(["check", "--watch", "--fix", f])).code).toBe(2);
  });
});

describe("CLI mutate --all and --fail-on-survived", () => {
  it("mutates imported local modules with --all, populates witness, and enforces --fail-on-survived", async () => {
    const dir = makeDir("mut-all");
    const lib = join(dir, "lib.szigyr");
    const testFile = join(dir, "lib.test.szigyr");
    writeFileSync(lib, `export function clampNonNeg(x: i32): i32 {
  if (x < 0) {
    return 0;
  }
  return x;
}
`);
    writeFileSync(testFile, `import { clampNonNeg } from "./lib.szigyr";
test("non-negative only", (t: Test) => {
  t.eq(clampNonNeg(5), 5);
});
`);

    // Without --all: entry file has only `test(...)`, so 0 targets.
    const noAll = await runCli(["mutate", "--no-cache", "--json", testFile]);
    expect(noAll.code).toBe(0);
    const noAllLines = jsonLines(noAll.out);
    expect(noAllLines.at(-1)).toMatchObject({ kind: "summary", targets: 0, killed: 0, survived: 0 });

    // With --all: mutates `clampNonNeg` in lib.szigyr; `if (x < 0)` -> `false` survives with witness [-1].
    const withAll = await runCli(["mutate", "--no-cache", "--json", "--all", testFile]);
    expect(withAll.code).toBe(0);
    const lines = jsonLines(withAll.out);
    const mutants = lines.filter((l) => l.kind === "mutant");
    const summary = lines.find((l) => l.kind === "summary");
    expect(summary.targets).toBeGreaterThanOrEqual(1);
    expect(summary.survived).toBeGreaterThanOrEqual(1);
    const survived = mutants.find((m) => m.status === "survived" && m.op === "if -> false");
    expect(survived).toBeDefined();
    expect(survived.file).toContain("lib.szigyr");
    expect(survived.witness).toEqual({ args: [-1], base: 0, mutant: -1 });

    // --fail-on-survived exits 1 when any mutant survives.
    const failRes = await runCli(["mutate", "--no-cache", "--all", "--fail-on-survived", testFile]);
    expect(failRes.code).toBe(1);

    // Stronger test kills every mutant -> --fail-on-survived exits 0.
    writeFileSync(lib, `export function isPositive(x: i32): boolean {
  return x > 0;
}
`);
    writeFileSync(testFile, `import { isPositive } from "./lib.szigyr";
test("boundary", (t: Test) => {
  t.eq(isPositive(0), false);
  t.eq(isPositive(1), true);
});
`);
    const passRes = await runCli(["mutate", "--no-cache", "--json", "--all", "--fail-on-survived", testFile]);
    expect(passRes.code).toBe(0);
    const passSummary = jsonLines(passRes.out).find((l) => l.kind === "summary");
    expect(passSummary.survived).toBe(0);
    expect(passSummary.killed).toBeGreaterThanOrEqual(1);
  });

  it("rejects --all and --fail-on-survived outside mutate with exit 2", async () => {
    const dir = makeDir("mut-bad");
    const f = join(dir, "app.szigyr");
    writeFileSync(f, `export function main(sys: System): void { sys.log.info("ok"); }\n`);
    expect((await runCli(["check", "--all", f])).code).toBe(2);
    expect((await runCli(["test", "--fail-on-survived", f])).code).toBe(2);
  });

  it("displays relative paths inside CWD and absolute paths outside CWD", async () => {
    const inside = await runCli(["check", "--json", "conformance/reject/E1001-var-in-function.szigyr"]);
    expect(inside.code).toBe(1);
    const inDiag = jsonLines(inside.out)[0];
    expect(inDiag.file).toBe("conformance/reject/E1001-var-in-function.szigyr");

    const dir = makeDir("outside-cwd");
    const outsideFile = join(dir, "bad.szigyr");
    writeFileSync(outsideFile, "function f(): i32 { var x: i32 = 1; return x; }\n");
    const outside = await runCli(["check", "--json", outsideFile]);
    expect(outside.code).toBe(1);
    const outDiag = jsonLines(outside.out)[0];
    expect(outDiag.file).toBe(outsideFile);
    expect(outDiag.file).not.toContain("..");
  });
});

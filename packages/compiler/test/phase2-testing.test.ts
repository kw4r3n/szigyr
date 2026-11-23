import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import { main as cliMain } from "../src/cli.ts";
import { CLI_NAME, mutate } from "../src/index.ts";
import { serveMcp } from "../src/mcp.ts";
import { startWatch, type WatchCycleInfo } from "../src/watch.ts";

const tmpRoots: string[] = [];
function makeTmp(prefix = `${CLI_NAME}-p2-`): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

async function runCli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "", err = "";
  const code = await cliMain(argv, (s) => { out += s; }, (s) => { err += s; });
  return { code, out, err };
}

function jsonLines(text: string): Record<string, any>[] {
  return text.trim().split(/\n+/).filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);
}

describe("Phase 2: multi-file test --all, --filter, mutate --all colocated tests, MCP worker reuse, and equiv filter", () => {
  it("supports test --all across value & type-only imports, deduplicates shared deps, and filters tests cleanly", async () => {
    const dir = makeTmp();
    const shared = join(dir, "shared.szigyr");
    const typesOnly = join(dir, "types_only.szigyr");
    const aFile = join(dir, "a.szigyr");
    const bFile = join(dir, "b.szigyr");

    writeFileSync(shared, [
      `export function addRt(a: i32, b: i32): i32 {`,
      `  "use rt";`,
      `  return a + b;`,
      `}`,
      `test("shared rt add", (t: Test) => {`,
      `  t.eq(addRt(2, 3), 5);`,
      `});`,
      ``,
    ].join("\n"));

    writeFileSync(typesOnly, [
      `export type Pair = { readonly x: i32; readonly y: i32 };`,
      `test("type module colocated", (t: Test) => {`,
      `  const p: Pair = { x: 1, y: 2 };`,
      `  t.eq(p.x + p.y, 3);`,
      `});`,
      ``,
    ].join("\n"));

    writeFileSync(aFile, [
      `import { addRt } from "./shared.szigyr";`,
      `import type { Pair } from "./types_only.szigyr";`,
      `export function runA(p: Pair): i32 { return addRt(p.x, p.y); }`,
      `test("alpha case", (t: Test) => { t.eq(runA({ x: 4, y: 6 }), 10); });`,
      ``,
    ].join("\n"));

    writeFileSync(bFile, [
      `import { addRt } from "./shared.szigyr";`,
      `test("Beta case", (t: Test) => { t.eq(addRt(1, 1), 2); });`,
      ``,
    ].join("\n"));

    // Default test runs entry only
    const entryOnly = await runCli(["test", "--json", aFile]);
    expect(entryOnly.code).toBe(0);
    const eoLines = jsonLines(entryOnly.out);
    expect(eoLines.filter((l) => l.kind === "test").map((l) => l.name)).toEqual(["alpha case"]);
    expect(eoLines.at(-1)).toEqual({ kind: "summary", passed: 1, failed: 0, backends: ["js"] });

    // --all runs entry + value-imported + type-only-imported tests across JS & C backends
    const allBoth = await runCli(["test", "--json", "--all", "--backend=both", aFile]);
    expect(allBoth.code).toBe(0);
    const allLines = jsonLines(allBoth.out);
    const allTests = allLines.filter((l) => l.kind === "test");
    expect(allTests.map((l) => l.name)).toEqual(["shared rt add", "alpha case", "type module colocated"]);
    expect(allTests[0]!.file).toContain("shared.szigyr");
    expect(allTests[1]!.file).toBe(aFile);
    expect(allTests[2]!.file).toContain("types_only.szigyr");
    expect(allLines.at(-1)).toEqual({ kind: "summary", passed: 3, failed: 0, backends: ["js", "c"] });

    // --backend=all reports all executed backends in both JSON and text summaries
    const allBackendsJson = await runCli(["test", "--json", "--backend=all", aFile]);
    expect(allBackendsJson.code).toBe(0);
    expect(jsonLines(allBackendsJson.out).at(-1)).toEqual({ kind: "summary", passed: 1, failed: 0, backends: ["js", "c", "wasm"] });
    const allBackendsText = await runCli(["test", "--backend=all", aFile]);
    expect(allBackendsText.code).toBe(0);
    expect(allBackendsText.out).toContain("1 passed, 0 failed (backends: js, c, wasm)\n");

    // --all across two entry files deduplicates shared.szigyr tests
    const dedup = await runCli(["test", "--all", aFile, bFile]);
    expect(dedup.code).toBe(0);
    expect(dedup.out).toContain("4 passed, 0 failed (backends: js)\n");
    expect(dedup.out).toContain("shared.szigyr > shared rt add");

    // --filter case-insensitive substring + skipped count (JSON and text) + combined with --all & --backend=both
    const filteredJson = await runCli(["test", "--json", "--all", "--filter=CASE", "--backend=both", aFile, bFile]);
    expect(filteredJson.code).toBe(0);
    const fjLines = jsonLines(filteredJson.out);
    expect(fjLines.filter((l) => l.kind === "test").map((l) => l.name)).toEqual(["alpha case", "Beta case"]);
    expect(fjLines.at(-1)).toEqual({ kind: "summary", passed: 2, failed: 0, skipped: 2, backends: ["js", "c"] });

    const filteredText = await runCli(["test", "--filter=beta", bFile]);
    expect(filteredText.code).toBe(0);
    expect(filteredText.out).toContain("ok Beta case\n");
    expect(filteredText.out).toContain("1 passed, 0 failed (backends: js)\n");

    const filteredSkipText = await runCli(["test", "--all", "--filter=SHARED", aFile]);
    expect(filteredSkipText.code).toBe(0);
    expect(filteredSkipText.out).toContain("1 passed, 0 failed, 2 skipped (backends: js)\n");

    // Invalid CLI flags exit 2
    expect((await runCli(["test", "--filter=", aFile])).code).toBe(2);
    expect((await runCli(["check", "--filter=a", aFile])).code).toBe(2);
    expect((await runCli(["run", "--filter=a", aFile])).code).toBe(2);
    expect((await runCli(["mutate", "--filter=a", aFile])).code).toBe(2);
    expect((await runCli(["prove", "--filter=a", aFile])).code).toBe(2);
    expect((await runCli(["mcp", "--filter=a"])).code).toBe(2);

    // Watch mode with --all and --filter
    const ac = new AbortController();
    let watchOut = "";
    const cycles: WatchCycleInfo[] = [];
    let waitIdx = 0;
    let wake: (() => void) | undefined;
    const nextCycle = (): Promise<WatchCycleInfo> =>
      waitIdx < cycles.length ? Promise.resolve(cycles[waitIdx++]!) : new Promise((r) => { wake = () => r(cycles[waitIdx++]!); });

    const wp = startWatch({
      files: [aFile],
      mode: "test",
      json: true,
      backends: ["js"],
      all: true,
      filter: "shared",
      out: (s) => { watchOut += s; },
      debounceMs: 20,
      signal: ac.signal,
      onCycle: (c) => { cycles.push(c); const w = wake; wake = undefined; w?.(); },
    });
    expect((await nextCycle()).ok).toBe(true);
    ac.abort();
    expect(await wp).toBe(0);
    expect(jsonLines(watchOut).find((l) => l.kind === "summary")).toEqual({ kind: "summary", passed: 1, failed: 0, skipped: 2, backends: ["js"] });
  }, 30_000);

  it("mutate --all uses colocated tests in imported modules and invalidates cache when imported test changes", async () => {
    const dir = makeTmp();
    const lib = join(dir, "lib.szigyr");
    const app = join(dir, "app.szigyr");
    const cacheFile = join(dir, ".szigyr-cache", "mutate.json");

    const libSrc = (testBody: string) => [
      `export function doubleNonNeg(x: i32): i32 {`,
      `  if (x < 0) return 0;`,
      `  return x * 2;`,
      `}`,
      `test("colocated lib", (t: Test) => {`,
      `  ${testBody}`,
      `});`,
      ``,
    ].join("\n");

    writeFileSync(lib, libSrc(`t.eq(doubleNonNeg(3), 6);`));
    writeFileSync(app, [
      `import { doubleNonNeg } from "./lib.szigyr";`,
      `export function main(sys: System): void { sys.log.info(\`\${doubleNonNeg(1)}\`); }`,
      ``,
    ].join("\n"));

    // Initial run: `x < 0` survives because colocated test only covers positive input (main skipped as System)
    const r1 = await mutate(app, { all: true, cache: true, cacheFile });
    expect(r1.diagnostics).toEqual([]);
    expect(r1.baselineFailure).toBeNull();
    expect(r1.summary.targets).toBe(1);
    const ifFalse1 = r1.mutants.find((m) => m.fn === "doubleNonNeg" && m.op === "if -> false")!;
    expect(ifFalse1.status).toBe("survived");

    // Strengthening ONLY the colocated test in lib.szigyr must invalidate doubleNonNeg's cache and kill the mutant
    writeFileSync(lib, libSrc(`t.eq(doubleNonNeg(3), 6); t.eq(doubleNonNeg(-1), 0);`));
    const r2 = await mutate(app, { all: true, cache: true, cacheFile });
    expect(r2.diagnostics).toEqual([]);
    const ifFalse2 = r2.mutants.find((m) => m.fn === "doubleNonNeg" && m.op === "if -> false")!;
    expect(ifFalse2.cached).toBe(false);
    expect(ifFalse2.status).toBe("killed");
  });

  it("reuses a persistent MCP worker across calls, supports szigyr_test all/filter, clears overlays, and recovers on timeout", async () => {
    const dir = makeTmp();
    const dep = join(dir, "dep.szigyr");
    const app = join(dir, "app.szigyr");
    const inf = join(dir, "inf.szigyr");
    writeFileSync(dep, `export function inc(x: i32): i32 { return x + 1; }\ntest("dep test", (t: Test) => { t.eq(inc(2), 3); });\n`);
    writeFileSync(app, `import { inc } from "./dep.szigyr";\nexport function main(sys: System): void { sys.log.info(\`\${inc(4)}\`); }\ntest("app test", (t: Test) => { t.eq(inc(4), 5); });\n`);
    writeFileSync(inf, `export function main(_sys: System): void { while (true) {} }\n`);

    const inStream = new PassThrough();
    const outStream = new PassThrough();
    const responses: Record<string, any>[] = [];
    const waiters: ((r: Record<string, any>) => void)[] = [];
    const rl = createInterface({ input: outStream, crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      const obj = JSON.parse(line) as Record<string, any>;
      const w = waiters.shift();
      if (w) w(obj); else responses.push(obj);
    });
    const nextResp = (): Promise<Record<string, any>> =>
      responses.length ? Promise.resolve(responses.shift()!) : new Promise((r) => waiters.push(r));

    const mcpPromise = serveMcp({ input: inStream, output: outStream });
    const rpc = async (msg: unknown) => { inStream.write(`${JSON.stringify(msg)}\n`); return await nextResp(); };

    await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

    // Validate new szigyr_test schema & validation errors
    expect((await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "szigyr_test", arguments: { file: app, all: "yes" } } })).error.code).toBe(-32602);
    expect((await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "szigyr_test", arguments: { file: app, filter: "" } } })).error.code).toBe(-32602);

    // Cold call spawns worker + tsgo parser; warm calls reuse both!
    const tAll = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "szigyr_test", arguments: { file: app, all: true } } });
    expect(tAll.result.structuredContent).toMatchObject({ ok: true, results: [{ name: "dep test", ok: true }, { name: "app test", ok: true }] });

    const tFiltered = await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "szigyr_test", arguments: { file: app, all: true, filter: "DEP" } } });
    expect(tFiltered.result.structuredContent).toMatchObject({ ok: true, skipped: 1, results: [{ name: "dep test", ok: true }] });

    // Overlay in szigyr_test must not leak to subsequent worker call
    const tOverlay = await rpc({
      jsonrpc: "2.0", id: 6, method: "tools/call",
      params: { name: "szigyr_test", arguments: { file: app, content: `test("override", (t: Test) => { t.ok(true); });\n` } },
    });
    expect(tOverlay.result.structuredContent.results.map((x: any) => x.name)).toEqual(["override"]);

    const warm0 = performance.now();
    const rAfterOverlay = await rpc({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "szigyr_run", arguments: { file: app } } });
    expect(performance.now() - warm0).toBeLessThan(1000);
    expect(rAfterOverlay.result.structuredContent).toMatchObject({ ok: true, stdout: "5\n" });

    // Worker timeout kills runaway worker and respawns cleanly for next call
    const to = await rpc({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "szigyr_run", arguments: { file: inf, timeoutMs: 250 } } });
    expect(to.result.isError).toBe(true);
    expect(to.result.structuredContent.timedOut).toBe(true);

    const tRecovered = await rpc({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "szigyr_test", arguments: { file: app } } });
    expect(tRecovered.result.structuredContent).toMatchObject({ ok: true, results: [{ name: "app test", ok: true }] });

    inStream.end();
    rl.close();
    expect(await mcpPromise).toBe(0);
  }, 30_000);

  it("suppresses provably equivalent Vec.create capacity and boundary tie-break mutants without hiding real mutants", async () => {
    const dir = makeTmp();
    const f = join(dir, "equiv.szigyr");
    writeFileSync(f, [
      `export function vecCapHint(alloc: Alloc, n: i32): usize {`,
      `  "use owned";`,
      `  const v = Vec.create<i32>(alloc, 8);`,
      `  v.push(n);`,
      `  return v.length;`,
      `}`,
      `export function poolCap(alloc: Alloc): boolean {`,
      `  "use owned";`,
      `  const p = Pool.create<i32>(alloc, 2);`,
      `  return p.capacity === 2;`,
      `}`,
      `export function minAssign(a: i32, b: i32): i32 {`,
      `  let m: i32 = a;`,
      `  if (b < m) { m = b; }`,
      `  return m;`,
      `}`,
      `export function maxTernary(a: i32, b: i32): i32 {`,
      `  return a > b ? a : b;`,
      `}`,
      `export function absDiff(a: i32, b: i32): i32 {`,
      `  return a < b ? b - a : a - b;`,
      `}`,
      `export function intAbsTernary(x: i32): i32 {`,
      `  return x < 0 ? -x : x;`,
      `}`,
      `export function intAbsEarly(x: i32): i32 {`,
      `  if (x < 0) return -x;`,
      `  return x;`,
      `}`,
      `export function clampByte(x: i32): i32 {`,
      `  if (x < 0) return 0;`,
      `  if (x > 255) return 255;`,
      `  return x;`,
      `}`,
      `export function addZero(x: i32): i32 {`,
      `  return x + 0;`,
      `}`,
      `test("suite", (t: Test) => {`,
      `  const al = TestAlloc.create();`,
      `  t.eq(vecCapHint(al, 4), 1);`,
      `  t.ok(poolCap(al));`,
      `  t.eq(minAssign(3, 1), 1); t.eq(minAssign(1, 3), 1);`,
      `  t.eq(maxTernary(3, 1), 3); t.eq(maxTernary(1, 3), 3);`,
      `  t.eq(absDiff(3, 5), 2); t.eq(absDiff(5, 3), 2);`,
      `  t.eq(intAbsTernary(-4), 4); t.eq(intAbsTernary(4), 4);`,
      `  t.eq(intAbsEarly(-4), 4); t.eq(intAbsEarly(4), 4);`,
      `  t.eq(clampByte(-1), 0); t.eq(clampByte(300), 255); t.eq(clampByte(10), 10);`,
      `  t.ok(true);`,
      `});`,
      ``,
    ].join("\n"));

    const r = await mutate(f, { cache: false });
    expect(r.diagnostics).toEqual([]);
    expect(r.baselineFailure).toBeNull();

    // Vec.create capacity `8 -> 0` must be suppressed; Pool.create capacity `2 -> 0` must NOT be suppressed
    expect(r.mutants.filter((m) => m.fn === "vecCapHint" && m.op === "num -> 0")).toEqual([]);
    expect(r.mutants.some((m) => m.fn === "poolCap" && m.op === "num -> 0" && m.status === "killed")).toBe(true);

    // Min/max/abs/clamp skip relational tie-breaks (`< -> <=`, `> -> >=`) while keeping `if -> true`/`if -> false`
    for (const fn of ["minAssign", "maxTernary", "absDiff", "intAbsTernary", "intAbsEarly", "clampByte"]) {
      expect(r.mutants.filter((m) => m.fn === fn && (m.op === "< -> <=" || m.op === "<= -> <" || m.op === "> -> >=" || m.op === ">= -> >")), fn).toEqual([]);
    }
    expect(r.mutants.some((m) => m.fn === "minAssign" && m.op === "if -> false" && m.status === "killed")).toBe(true);
    expect(r.mutants.some((m) => m.fn === "clampByte" && m.op === "if -> true" && m.status === "killed")).toBe(true);

    // Deliberate `x + 0` `+ -> -` is NOT silently suppressed!
    expect(r.mutants.some((m) => m.fn === "addZero" && m.op === "+ -> -" && m.status === "survived")).toBe(true);
  });
});

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import { main as cliMain } from "../src/cli.ts";
import { check, createParser } from "../src/index.ts";
import { serveMcp } from "../src/mcp.ts";
import { startWatch, type WatchCycleInfo } from "../src/watch.ts";

const tmpRoots: string[] = [];
function makeTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
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

describe("resident incremental checker, --watch mode, and stdio MCP server", () => {
  it("supports multi-file incremental re-checking, file deletion/restoration, overlays, and sub-25ms warm latency", () => {
    const dir = makeTmp("szigyr-resident-");
    const dep = join(dir, "dep.szigyr");
    const main = join(dir, "main.szigyr");
    writeFileSync(dep, `export function factor(x: i32): i32 {\n  return x * 2;\n}\n`);
    writeFileSync(main, `import { factor } from "./dep.szigyr";\nexport function runCalc(n: i32): i32 {\n  return factor(n) + 1;\n}\n`);

    const parser = createParser();
    try {
      // Cold first check
      expect(check(main, parser)).toEqual([]);

      // Break dep signature -> unchanged main.szigyr must detect type error (no stale WeakMaps)
      writeFileSync(dep, `export function factor(x: string): string {\n  return x;\n}\n`);
      const broken = check(main, parser);
      expect(broken.some((d) => d.code === "E2002")).toBe(true);

      // Restore dep -> passes cleanly
      writeFileSync(dep, `export function factor(x: i32): i32 {\n  return x * 3;\n}\n`);
      expect(check(main, parser)).toEqual([]);

      // Delete dep -> E7001, then restore -> clean again
      unlinkSync(dep);
      const missing = check(main, parser);
      expect(missing.some((d) => d.code === "E7001")).toBe(true);
      writeFileSync(dep, `export function factor(x: i32): i32 {\n  return x * 4;\n}\n`);
      expect(check(main, parser)).toEqual([]);

      // Benchmark 5 warm edits
      const warmSamples: number[] = [];
      for (let k = 1; k <= 5; k += 1) {
        writeFileSync(dep, `export function factor(x: i32): i32 {\n  return x * ${k + 10};\n}\n`);
        const t0 = performance.now();
        const ds = check(main, parser);
        warmSamples.push(performance.now() - t0);
        expect(ds).toEqual([]);
      }
      const sorted = [...warmSamples].sort((a, b) => a - b);
      const medianMs = sorted[Math.floor(sorted.length / 2)]!;
      expect(medianMs).toBeLessThan(25);

      // Overlay edits override disk without modifying it, and work on non-existent files
      parser.setOverlay?.(dep, `export function factor(x: boolean): boolean {\n  return x;\n}\n`);
      expect(check(main, parser).some((d) => d.code === "E2002")).toBe(true);
      parser.clearOverlay?.(dep);
      expect(check(main, parser)).toEqual([]);

      const ghost = join(dir, "unsaved.szigyr");
      parser.setOverlay?.(ghost, `export function add(a: i32, b: i32): i32 { return a + b; }\n`);
      expect(check(ghost, parser)).toEqual([]);
      parser.clearOverlay?.(ghost);
    } finally {
      parser.close();
    }
  });

  it("watches multi-file dependencies for check --json and test modes, and validates CLI flags", async () => {
    const dir = makeTmp("szigyr-watch-");
    const dep = join(dir, "dep.szigyr");
    const entry = join(dir, "app.szigyr");
    writeFileSync(dep, `export function val(): i32 { return 10; }\n`);
    writeFileSync(entry, `import { val } from "./dep.szigyr";\nexport function ans(): i32 { return val() + 1; }\n`);

    const ac1 = new AbortController();
    let out1 = "";
    const cycles1: WatchCycleInfo[] = [];
    let waitIdx1 = 0;
    let wake1: (() => void) | undefined;
    const nextCycle1 = (): Promise<WatchCycleInfo> => {
      if (waitIdx1 < cycles1.length) return Promise.resolve(cycles1[waitIdx1++]!);
      return new Promise((r) => { wake1 = () => r(cycles1[waitIdx1++]!); });
    };

    const watchP1 = startWatch({
      files: [entry],
      mode: "check",
      json: true,
      backends: ["js"],
      out: (s) => { out1 += s; },
      debounceMs: 20,
      signal: ac1.signal,
      onCycle: (c) => {
        cycles1.push(c);
        const w = wake1; wake1 = undefined; w?.();
      },
    });

    const c1 = await nextCycle1();
    expect(c1.ok).toBe(true);
    expect(c1.errors).toBe(0);

    writeFileSync(dep, `export function val(): string { return "bad"; }\n`);
    const c2 = await nextCycle1();
    expect(c2.ok).toBe(false);
    expect(c2.errors).toBeGreaterThan(0);

    writeFileSync(dep, `export function val(): i32 { return 42; }\n`);
    const c3 = await nextCycle1();
    expect(c3.ok).toBe(true);
    ac1.abort();
    expect(await watchP1).toBe(0);

    const recs = jsonLines(out1);
    expect(recs.some((r) => r.kind === "watch-start" && r.mode === "check")).toBe(true);
    expect(recs.some((r) => r.code === "E2002")).toBe(true);
    expect(recs.filter((r) => r.kind === "watch-done").map((r) => r.ok)).toEqual([true, false, true]);

    // Watch test mode re-runs on save
    const testFile = join(dir, "math_test.szigyr");
    writeFileSync(testFile, `function inc(x: i32): i32 { return x + 1; }\ntest("inc", (t: Test) => { t.eq(inc(2), 3); });\n`);
    const ac2 = new AbortController();
    let out2 = "";
    const cycles2: WatchCycleInfo[] = [];
    let waitIdx2 = 0;
    let wake2: (() => void) | undefined;
    const nextCycle2 = (): Promise<WatchCycleInfo> => {
      if (waitIdx2 < cycles2.length) return Promise.resolve(cycles2[waitIdx2++]!);
      return new Promise((r) => { wake2 = () => r(cycles2[waitIdx2++]!); });
    };
    const watchP2 = startWatch({
      files: [testFile],
      mode: "test",
      json: true,
      backends: ["js"],
      out: (s) => { out2 += s; },
      debounceMs: 20,
      signal: ac2.signal,
      onCycle: (c) => {
        cycles2.push(c);
        const w = wake2; wake2 = undefined; w?.();
      },
    });
    expect((await nextCycle2()).ok).toBe(true);
    writeFileSync(testFile, `function inc(x: i32): i32 { return x + 2; }\ntest("inc", (t: Test) => { t.eq(inc(2), 3); });\n`);
    expect((await nextCycle2()).ok).toBe(false);
    ac2.abort();
    expect(await watchP2).toBe(0);
    expect(jsonLines(out2).filter((r) => r.kind === "summary").map((r) => [r.passed, r.failed])).toEqual([[1, 0], [0, 1]]);

    // CLI flag validation for --watch and mcp
    expect((await runCli(["run", "--watch", entry])).code).toBe(2);
    expect((await runCli(["build", "--target=node", "--watch", entry])).code).toBe(2);
    expect((await runCli(["mcp", "--watch"])).code).toBe(2);
    expect((await runCli(["mcp", entry])).code).toBe(2);
  });

  it("serves JSON-RPC 2.0 MCP tools in-process (all 7 tools, multi-file overlays, errors) and via isolated stdio CLI subprocess", async () => {
    const dir = makeTmp("szigyr-mcp-");
    const file = join(dir, "sample.szigyr");
    writeFileSync(file, `export function add(a: i32, b: i32): i32 {\n  "use rt";\n  return a + b;\n}\ntest("add", (t: Test) => {\n  t.eq(add(2, 3), 5);\n});\n`);

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
    const nextResp = (): Promise<Record<string, any>> => {
      if (responses.length) return Promise.resolve(responses.shift()!);
      return new Promise((r) => waiters.push(r));
    };

    const mcpPromise = serveMcp({ input: inStream, output: outStream });

    const rpc = async (msg: unknown) => {
      inStream.write(`${JSON.stringify(msg)}\n`);
      return await nextResp();
    };

    const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
    expect(init.result).toMatchObject({
      protocolVersion: "2025-03-26",
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: "szigyr" },
    });

    // Notifications must not produce a response
    inStream.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const ping = await rpc({ jsonrpc: "2.0", id: 2, method: "ping" });
    expect(ping).toEqual({ jsonrpc: "2.0", id: 2, result: {} });

    const list = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    const names = (list.result.tools as { name: string }[]).map((t) => t.name);
    expect(names).toEqual(["szigyr_check", "szigyr_query", "szigyr_explain", "szigyr_test", "szigyr_mutate", "szigyr_run", "szigyr_prove"]);

    // resources/list & resources/read
    const resList = await rpc({ jsonrpc: "2.0", id: 31, method: "resources/list" });
    const resUris = (resList.result.resources as { uri: string }[]).map((r) => r.uri);
    expect(resUris).toEqual(["szigyr://spec", "szigyr://builtins"]);

    const specRead = await rpc({ jsonrpc: "2.0", id: 32, method: "resources/read", params: { uri: "szigyr://spec" } });
    expect(specRead.result.contents).toHaveLength(1);
    expect(specRead.result.contents[0]).toMatchObject({ uri: "szigyr://spec", mimeType: "text/markdown" });
    expect(specRead.result.contents[0].text).toContain("Szigyr");

    const builtinsRead = await rpc({ jsonrpc: "2.0", id: 33, method: "resources/read", params: { uri: "szigyr://builtins" } });
    expect(builtinsRead.result.contents).toHaveLength(1);
    expect(builtinsRead.result.contents[0]).toMatchObject({ uri: "szigyr://builtins", mimeType: "application/json" });
    const builtinsJson = JSON.parse(builtinsRead.result.contents[0].text) as Record<string, any>;
    expect(builtinsJson.namespaces.Math).toBeDefined();
    expect(builtinsJson.namespaces.Math.min.signature).not.toContain("[]");
    expect(builtinsJson.namespaces.Math.min.signature).not.toContain("...");
    expect(builtinsJson.namespaces.JSON.stringify.signature).toContain("indent?: u8");
    expect(builtinsJson.namespaces.JSON.stringify.minArgs).toBe(1);
    expect(builtinsJson.namespaces.JSON.get).toBeDefined();
    expect(builtinsJson.namespaces.String.encodeUtf8).toBeDefined();
    expect(builtinsJson.opaqueTypes.Proc.setExitCode).toBeDefined();
    expect(builtinsJson.string.slice).toBeDefined();
    expect(builtinsJson.genericTypes.Vec).toBeDefined();
    expect(builtinsJson.capabilities).toContain("Copy");
    expect(builtinsJson.reserved).toContain("bigint");
    expect(builtinsJson.functions).toContain("wrapAdd");

    const badResRead = await rpc({ jsonrpc: "2.0", id: 34, method: "resources/read", params: { uri: "szigyr://unknown" } });
    expect(badResRead.error.code).toBe(-32602);
    const emptyResRead = await rpc({ jsonrpc: "2.0", id: 35, method: "resources/read", params: {} });
    expect(emptyResRead.error.code).toBe(-32602);

    // szigyr_check (disk + unsaved single/multi-file overlays + verify overlays did not leak)
    const chkDisk = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "szigyr_check", arguments: { file } } });
    expect(chkDisk.result.structuredContent).toMatchObject({ ok: true, diagnostics: [] });

    const chkBadOverlay = await rpc({
      jsonrpc: "2.0", id: 5, method: "tools/call",
      params: { name: "szigyr_check", arguments: { file, content: `export function add(a: i32, b: i32): string { return a + b; }\n` } },
    });
    expect(chkBadOverlay.result.structuredContent.ok).toBe(false);
    expect(chkBadOverlay.result.structuredContent.diagnostics[0].code).toBe("E2002");

    const virtMain = join(dir, "virtual-main.szigyr");
    const virtDep = join(dir, "virtual-dep.szigyr");
    const chkMultiOverlay = await rpc({
      jsonrpc: "2.0", id: 51, method: "tools/call",
      params: {
        name: "szigyr_check",
        arguments: {
          file: virtMain,
          overlays: {
            [virtMain]: `import { helper } from "./virtual-dep.szigyr";\nexport function runVirt(n: i32): i32 { return helper(n) + 1; }\n`,
            [virtDep]: `export function helper(n: i32): i32 { return n * 2; }\n`,
          },
        },
      },
    });
    expect(chkMultiOverlay.result.structuredContent).toMatchObject({ ok: true, diagnostics: [] });

    const chkAfterOverlay = await rpc({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "szigyr_check", arguments: { file } } });
    expect(chkAfterOverlay.result.structuredContent.ok).toBe(true);

    // szigyr_query (ok flag, class ctor/implements/fields, interface methods, strict+unsafe pure: false)
    const qry = await rpc({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "szigyr_query", arguments: { file } } });
    expect(qry.result.structuredContent.ok).toBe(true);
    expect(qry.result.structuredContent.symbols.find((s: Record<string, unknown>) => s.name === "add")).toMatchObject({
      kind: "function", layer: "rt", pure: true, mutatable: true,
    });
    const qryErr = await rpc({
      jsonrpc: "2.0", id: 70, method: "tools/call",
      params: { name: "szigyr_query", arguments: { file, content: `export function bad(a: i32): string { return a; }\n` } },
    });
    expect(qryErr.result.structuredContent.ok).toBe(false);
    expect(qryErr.result.structuredContent.diagnostics.length).toBeGreaterThan(0);
    const qryRich = await rpc({
      jsonrpc: "2.0", id: 71, method: "tools/call",
      params: {
        name: "szigyr_query",
        arguments: {
          file: virtMain,
          content: [
            `export interface Greeter { greet(who: string): string; }`,
            `export class Bot implements Greeter {`,
            `  readonly name: string;`,
            `  private count: i32 = 0;`,
            `  constructor(name: string) { this.name = name; }`,
            `  greet(who: string): string { return \`\${this.name}:\${who}\`; }`,
            `}`,
            `export function rawNull(): boolean { "use owned"; "use unsafe"; return Ptr.null<i32>().isNull(); }`,
          ].join("\n"),
        },
      },
    });
    const richSyms = qryRich.result.structuredContent.symbols as Record<string, any>[];
    expect(richSyms.find((s) => s.name === "Greeter")).toMatchObject({
      kind: "interface", methods: [{ name: "greet", type: "(string) => string" }],
    });
    expect(richSyms.find((s) => s.name === "Bot")).toMatchObject({
      kind: "class",
      ctor: "(string) => Bot",
      implements: ["Greeter"],
      fields: [
        { name: "name", type: "string", readonly: true, private: false, static: false },
        { name: "count", type: "i32", readonly: false, private: true, static: false },
      ],
    });
    expect(richSyms.find((s) => s.name === "rawNull")).toMatchObject({
      kind: "function", layer: "strict", unsafe: true, pure: false, mutatable: false,
    });

    // szigyr_explain
    const expOk = await rpc({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "szigyr_explain", arguments: { code: "E2007" } } });
    expect(expOk.result.isError).toBeUndefined();
    expect(expOk.result.structuredContent).toMatchObject({ code: "E2007", phase: "P2" });
    const expErr = await rpc({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "szigyr_explain", arguments: { code: "E9999" } } });
    expect(expErr.result.isError).toBe(true);

    // szigyr_test, szigyr_mutate & szigyr_run (subprocess-isolated)
    const tst = await rpc({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "szigyr_test", arguments: { file, backend: "js" } } });
    expect(tst.result.structuredContent).toMatchObject({ ok: true, results: [{ name: "add", ok: true }] });

    const virtTestDep = join(dir, "virt-test-dep.szigyr");
    const virtTestMain = join(dir, "virt-test-main.szigyr");
    const virtRunMain = join(dir, "virt-run-main.szigyr");
    const virtTestOverlays = {
      [virtTestDep]: `export function mul2(x: i32): i32 {\n  "use rt";\n  return x * 2;\n}\n`,
      [virtTestMain]: [
        `import { mul2 } from "./virt-test-dep.szigyr";`,
        `export function calc(x: i32): i32 { "use rt"; return mul2(x) + 1; }`,
        `test("virt all", (t: Test) => { t.eq(calc(4), 9); });`,
      ].join("\n"),
    };
    const tstAllOverlays = await rpc({
      jsonrpc: "2.0", id: 101, method: "tools/call",
      params: { name: "szigyr_test", arguments: { file: virtTestMain, overlays: virtTestOverlays, backend: "all" } },
    });
    expect(tstAllOverlays.result.structuredContent).toMatchObject({
      ok: true,
      backend: "all",
      diagnostics: [],
      results: [{ name: "virt all", ok: true }],
    });
    expect(tstAllOverlays.result.structuredContent.mismatch).toBeUndefined();

    const tstContent = await rpc({
      jsonrpc: "2.0", id: 102, method: "tools/call",
      params: {
        name: "szigyr_test",
        arguments: {
          file: virtTestMain,
          overlays: { [virtTestDep]: virtTestOverlays[virtTestDep] },
          content: `import { mul2 } from "./virt-test-dep.szigyr";\ntest("virt content", (t: Test) => { t.eq(mul2(5), 10); });\n`,
          backend: "js",
        },
      },
    });
    expect(tstContent.result.structuredContent).toMatchObject({ ok: true, results: [{ name: "virt content", ok: true }] });

    const mut = await rpc({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "szigyr_mutate", arguments: { file, noCache: true, failOnSurvived: true } } });
    expect(mut.result.structuredContent.ok).toBe(true);
    expect(mut.result.structuredContent.summary.killed).toBeGreaterThan(0);
    expect(mut.result.structuredContent.summary.survived).toBe(0);

    const survMutFile = join(dir, "surv-mut.szigyr");
    writeFileSync(survMutFile, `export function combine(a: i32, b: i32): i32 { return a + b; }\ntest("weak", (t: Test) => { t.eq(combine(0, 0), 0); });\n`);
    const mutSurvOk = await rpc({ jsonrpc: "2.0", id: 111, method: "tools/call", params: { name: "szigyr_mutate", arguments: { file: survMutFile, noCache: true } } });
    expect(mutSurvOk.result.structuredContent.ok).toBe(true);
    expect(mutSurvOk.result.structuredContent.summary.survived).toBeGreaterThan(0);
    const mutSurvFail = await rpc({ jsonrpc: "2.0", id: 112, method: "tools/call", params: { name: "szigyr_mutate", arguments: { file: survMutFile, noCache: true, failOnSurvived: true } } });
    expect(mutSurvFail.result.structuredContent.ok).toBe(false);
    expect(mutSurvFail.result.structuredContent.summary.survived).toBeGreaterThan(0);

    const mutHelper = join(dir, "mut-helper.szigyr");
    const mutEntry = join(dir, "mut-entry.szigyr");
    writeFileSync(mutHelper, `export function helper(x: i32): i32 { return x + 10; }\n`);
    writeFileSync(mutEntry, `import { helper } from "./mut-helper.szigyr";\nexport function entry(x: i32): i32 { return helper(x) * 2; }\ntest("multi", (t: Test) => { t.eq(entry(3), 26); });\n`);
    const mutEntryOnly = await rpc({ jsonrpc: "2.0", id: 113, method: "tools/call", params: { name: "szigyr_mutate", arguments: { file: mutEntry, noCache: true } } });
    expect(mutEntryOnly.result.structuredContent.mutants.some((m: Record<string, any>) => String(m.file).endsWith("mut-helper.szigyr"))).toBe(false);
    const mutAll = await rpc({ jsonrpc: "2.0", id: 114, method: "tools/call", params: { name: "szigyr_mutate", arguments: { file: mutEntry, noCache: true, all: true } } });
    expect(mutAll.result.structuredContent.ok).toBe(true);
    expect(mutAll.result.structuredContent.mutants.some((m: Record<string, any>) => String(m.file).endsWith("mut-helper.szigyr"))).toBe(true);

    const badMutFile = join(dir, "bad-mut.szigyr");
    writeFileSync(badMutFile, `export function add(a: i32, b: i32): i32 { return a + b; }\ntest("fail", (t: Test) => { t.eq(add(1, 2), 99); });\n`);
    const mutBad = await rpc({ jsonrpc: "2.0", id: 110, method: "tools/call", params: { name: "szigyr_mutate", arguments: { file: badMutFile, noCache: true } } });
    expect(mutBad.result.structuredContent.ok).toBe(false);
    expect(mutBad.result.structuredContent.baselineFailure).not.toBeNull();

    const runFile = join(dir, "run-main.szigyr");
    writeFileSync(runFile, `export function main(sys: System): void {\n  sys.log.info("hello-mcp");\n}\n`);
    const runRes = await rpc({ jsonrpc: "2.0", id: 14, method: "tools/call", params: { name: "szigyr_run", arguments: { file: runFile, backend: "js" } } });
    expect(runRes.result.structuredContent).toMatchObject({ ok: true, stdout: "hello-mcp\n", diagnostics: [] });

    const runAllOverlays = await rpc({
      jsonrpc: "2.0", id: 141, method: "tools/call",
      params: {
        name: "szigyr_run",
        arguments: {
          file: virtRunMain,
          overlays: { [virtTestDep]: virtTestOverlays[virtTestDep] },
          content: [
            `import { mul2 } from "./virt-test-dep.szigyr";`,
            `export function main(sys: System): void {`,
            `  sys.log.info(\`ans=\${mul2(21)}\`);`,
            `}`,
          ].join("\n"),
          backend: "all",
        },
      },
    });
    expect(runAllOverlays.result.structuredContent).toMatchObject({ ok: true, backend: "all", stdout: "ans=42\n", diagnostics: [] });
    expect(runAllOverlays.result.structuredContent.mismatch).toBeUndefined();

    // Validation errors for new mutate/backend flags -> -32602
    expect((await rpc({ jsonrpc: "2.0", id: 142, method: "tools/call", params: { name: "szigyr_mutate", arguments: { file, all: "yes" } } })).error.code).toBe(-32602);
    expect((await rpc({ jsonrpc: "2.0", id: 143, method: "tools/call", params: { name: "szigyr_mutate", arguments: { file, failOnSurvived: 1 } } })).error.code).toBe(-32602);
    expect((await rpc({ jsonrpc: "2.0", id: 144, method: "tools/call", params: { name: "szigyr_run", arguments: { file: runFile, backend: "nope" } } })).error.code).toBe(-32602);

    // Worker timeout protection on infinite loop + session recovery
    const loopFile = join(dir, "inf-loop.szigyr");
    writeFileSync(loopFile, `export function main(_sys: System): void {\n  while (true) {}\n}\n`);
    const tLoop0 = performance.now();
    const loopRes = await rpc({
      jsonrpc: "2.0", id: 15, method: "tools/call",
      params: { name: "szigyr_run", arguments: { file: loopFile, backend: "js", timeoutMs: 300 } },
    });
    expect(performance.now() - tLoop0).toBeLessThan(5000);
    expect(loopRes.result.isError).toBe(true);
    expect(loopRes.result.structuredContent).toMatchObject({ ok: false, timedOut: true });

    // Subsequent ping and szigyr_check succeed cleanly on the same MCP session
    expect(await rpc({ jsonrpc: "2.0", id: 16, method: "ping" })).toEqual({ jsonrpc: "2.0", id: 16, result: {} });
    const chkAfterTimeout = await rpc({ jsonrpc: "2.0", id: 17, method: "tools/call", params: { name: "szigyr_check", arguments: { file } } });
    expect(chkAfterTimeout.result.structuredContent).toMatchObject({ ok: true, diagnostics: [] });

    // Invalid timeoutMs -> -32602
    for (const badTimeout of [50, 300001, 1.5, "300"]) {
      const badTo = await rpc({
        jsonrpc: "2.0", id: 18, method: "tools/call",
        params: { name: "szigyr_run", arguments: { file: runFile, timeoutMs: badTimeout } },
      });
      expect(badTo.error.code).toBe(-32602);
    }

    // Protocol errors (-32700, -32601, -32602)
    inStream.write("{bad json\n");
    expect((await nextResp()).error.code).toBe(-32700);
    expect((await rpc({ jsonrpc: "2.0", id: 12, method: "no/suchMethod" })).error.code).toBe(-32601);
    expect((await rpc({ jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "unknown_tool", arguments: {} } })).error.code).toBe(-32602);

    inStream.end();
    rl.close();
    expect(await mcpPromise).toBe(0);

    // Real subprocess test: `node packages/compiler/src/cli.ts mcp` + noisy npm console.log isolation
    const modDir = join(dir, "node_modules/noisy");
    mkdirSync(modDir, { recursive: true });
    writeFileSync(join(modDir, "package.json"), JSON.stringify({ name: "noisy", version: "1.0.0", type: "module", main: "index.mjs" }));
    writeFileSync(join(modDir, "index.mjs"), `console.log("NOISE_ON_STDOUT"); export function poke() { console.log("NOISE_ON_CALL"); return 42; }\n`);
    const noisyTest = join(dir, "noisy.test.szigyr");
    writeFileSync(noisyTest, [
      `import { poke } from "npm:noisy";`,
      `test("noisy npm isolated", (t: Test) => {`,
      `  t.ok(true);`,
      `});`,
      `export function keepPoke(sys: System): void { sys.js.call(poke, []); }`,
    ].join("\n"));
    const noisyRun = join(dir, "noisy-run.szigyr");
    writeFileSync(noisyRun, [
      `import { poke } from "npm:noisy";`,
      `export function main(sys: System): void {`,
      `  const r = sys.js.call(poke, []);`,
      `  if (r.kind === "ok") sys.log.info("ran");`,
      `}`,
    ].join("\n"));

    const cliPath = join(import.meta.dirname, "../src/cli.ts");
    const child = spawn(process.execPath, [cliPath, "mcp"], { stdio: ["pipe", "pipe", "pipe"] });
    let subOut = "", subErr = "";
    child.stdout.on("data", (d) => { subOut += d.toString("utf8"); });
    child.stderr.on("data", (d) => { subErr += d.toString("utf8"); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "szigyr_check", arguments: { file } } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "szigyr_test", arguments: { file: noisyTest, backend: "js" } } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "szigyr_run", arguments: { file: noisyRun, backend: "js" } } })}\n`);
    child.stdin.end();
    const exitCode = await new Promise<number | null>((res) => child.on("close", res));
    expect(exitCode, subErr).toBe(0);
    expect(subOut).not.toContain("NOISE_ON_STDOUT");
    expect(subOut).not.toContain("NOISE_ON_CALL");
    const subLines = jsonLines(subOut);
    expect(subLines).toHaveLength(4);
    expect(subLines[0]!.id).toBe(1);
    expect(subLines[1]!.id).toBe(2);
    expect(subLines[1]!.result.structuredContent.ok).toBe(true);
    expect(subLines[2]!.id).toBe(3);
    expect(subLines[2]!.result.structuredContent).toMatchObject({ ok: true, results: [{ name: "noisy npm isolated", ok: true }] });
    expect(subLines[3]!.id).toBe(4);
    expect(subLines[3]!.result.structuredContent).toMatchObject({ ok: true, stdout: "ran\n" });
  }, 60000);
});

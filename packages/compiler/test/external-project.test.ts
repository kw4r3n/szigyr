import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const CLI_REAL = resolve(import.meta.dirname, "../src/cli.ts");
const roots: string[] = [];

function runBin(bin: string, args: string[], cwd: string, input?: string) {
  return spawnSync(bin, args, { cwd, input, encoding: "utf8" });
}

function jsonLines(s: string): Record<string, any>[] {
  return s.trim().split(/\r?\n+/).filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);
}

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe("external project CLI & MCP integration", () => {
  it("runs check, query, test, run, prove, mutate, release build (node/browser), and mcp from an isolated external directory", () => {
    const ext = mkdtempSync(join(tmpdir(), "szigyr-ext-"));
    roots.push(ext);

    mkdirSync(join(ext, "bin"), { recursive: true });
    const bin = join(ext, "bin/szigyr");
    symlinkSync(CLI_REAL, bin);

    const proj = join(ext, "ext-app");
    mkdirSync(join(proj, "src"), { recursive: true });
    mkdirSync(join(proj, "node_modules/ext-helper"), { recursive: true });
    writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "ext-app", type: "module" }));
    writeFileSync(join(proj, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, target: "ES2022" } }));
    writeFileSync(join(proj, "node_modules/ext-helper/package.json"), JSON.stringify({ name: "ext-helper", type: "module", main: "index.js" }));
    writeFileSync(join(proj, "node_modules/ext-helper/index.js"), "export function shout(s) { return s.toUpperCase() + \"!\"; }\n");

    writeFileSync(join(proj, "src/core.szigyr"), `
export function sumBytes(xs: Ref<Slice<u8>>): usize {
  "use rt";
  requires(xs.length <= 1000);
  let acc: usize = 0;
  for (let i: usize = 0; i < xs.length; i += 1) {
    invariant(acc <= i * 255);
    acc += usize(xs[i]);
  }
  return acc;
}
`);

    writeFileSync(join(proj, "src/main.szigyr"), `
import { sumBytes } from "./core.szigyr";
import { shout } from "npm:ext-helper";

export function main(sys: System): void {
  const v = Vec.create<u8>(sys.alloc, 3);
  v.push(u8(10));
  v.push(u8(20));
  v.push(u8(12));
  const args = sys.proc.args();
  const label = args.length > 0 ? args[0] : "ok";
  const res = sys.js.call(shout, [sys.js.encode<string>(label)]);
  const decoded = res.kind === "ok" ? sys.js.decode<string>(res.value) : null;
  const text = decoded !== null && decoded.kind === "ok" ? decoded.value : "err";
  sys.log.info(\`\${text}:\${sumBytes(v)}\`);
}

test("sumBytes covers empty and multi-byte slices", (t: Test) => {
  const alloc = TestAlloc.create();
  const empty = Vec.create<u8>(alloc, 0);
  t.eq(sumBytes(empty), usize(0));

  const v = Vec.create<u8>(alloc, 3);
  v.push(u8(10));
  v.push(u8(20));
  v.push(u8(12));
  t.eq(sumBytes(v), usize(42));
});
`);

    // 1. check
    const chk = runBin(bin, ["check", "src/main.szigyr"], proj);
    expect(chk.status).toBe(0);
    expect(chk.stdout).toBe("");

    // 2. query --json
    const qry = runBin(bin, ["query", "--json", "src/core.szigyr"], proj);
    expect(qry.status).toBe(0);
    expect(jsonLines(qry.stdout).some((s) => s.kind === "symbol" && s.name === "sumBytes")).toBe(true);

    // 3. test --backend=all
    const tst = runBin(bin, ["test", "--backend=all", "src/main.szigyr"], proj);
    expect(tst.status).toBe(0);

    // 4. run --backend=all -- hi
    const rn = runBin(bin, ["run", "--backend=all", "src/main.szigyr", "--", "hi"], proj);
    expect(rn.status).toBe(0);
    expect(rn.stdout).toBe("HI!:42\n");

    // 5. prove --all --strict --json + .szigyr-cache/prove.json in proj
    const prv = runBin(bin, ["prove", "--all", "--strict", "--json", "src/main.szigyr"], proj);
    expect(prv.status).toBe(0);
    const proveSummary = jsonLines(prv.stdout).find((l) => l.kind === "prove-summary");
    expect(proveSummary).toBeDefined();
    expect(proveSummary!.failed).toBe(0);
    expect(proveSummary!.unknown).toBe(0);
    expect(proveSummary!.timeout).toBe(0);
    expect(proveSummary!.proved).toBeGreaterThan(0);
    expect(existsSync(join(proj, ".szigyr-cache/prove.json"))).toBe(true);

    // 6. mutate --all --fail-on-survived --json + .szigyr-cache/mutate.json in proj
    const mut = runBin(bin, ["mutate", "--all", "--fail-on-survived", "--json", "src/main.szigyr"], proj);
    expect(mut.status).toBe(0);
    const mutSummary = jsonLines(mut.stdout).find((l) => l.kind === "summary");
    expect(mutSummary).toBeDefined();
    expect(mutSummary!.survived).toBe(0);
    expect(mutSummary!.killed).toBeGreaterThan(0);
    expect(existsSync(join(proj, ".szigyr-cache/mutate.json"))).toBe(true);

    // 7. build --target=node --backend=c --release --json + relocated standalone execution
    const bNode = runBin(bin, ["build", "--target=node", "--backend=c", "--release", "--json", "-o", "dist-node", "src/main.szigyr"], proj);
    expect(bNode.status).toBe(0);
    const bNodeJson = JSON.parse(bNode.stdout.trim());
    expect(bNodeJson.release).toBe(true);
    expect(bNodeJson.provedEliminated).toBeGreaterThan(0);

    const relocated = join(ext, "relocated");
    cpSync(join(proj, "dist-node"), relocated, { recursive: true });
    const relRun = runBin(process.execPath, ["main.js", "moved"], relocated);
    expect(relRun.status).toBe(0);
    expect(relRun.stdout).toBe("MOVED!:42\n");

    // 8. build --target=browser --release --json
    const bWeb = runBin(bin, ["build", "--target=browser", "--release", "--json", "-o", "dist-web", "src/main.szigyr"], proj);
    expect(bWeb.status).toBe(0);
    const bWebJson = JSON.parse(bWeb.stdout.trim());
    expect(bWebJson.release).toBe(true);
    expect(bWebJson.provedEliminated).toBeGreaterThan(0);
    expect(bWebJson.files).toEqual(expect.arrayContaining(["program.wasm", "app.js", "vendor/v0.js"]));

    // 9. mcp from external cwd
    const mcpIn = [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: "szigyr://spec" } }),
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri: "szigyr://builtins" } }),
      JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "szigyr_check", arguments: { file: "src/main.szigyr" } } }),
      JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "szigyr_prove", arguments: { file: "src/main.szigyr", all: true, strict: true } } }),
      JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "szigyr_test", arguments: { file: "src/main.szigyr", backend: "all" } } }),
    ].join("\n") + "\n";
    const mcp = runBin(bin, ["mcp"], proj, mcpIn);
    expect(mcp.status).toBe(0);
    const msgs = jsonLines(mcp.stdout);
    expect(msgs.length).toBe(6);
    expect(msgs[1]!.result.contents[0].text.length).toBeGreaterThan(1000);
    expect(JSON.parse(msgs[2]!.result.contents[0].text).functions).toBeDefined();
    expect(msgs[3]!.result.structuredContent.ok).toBe(true);
    expect(msgs[4]!.result.structuredContent.ok).toBe(true);
    expect(msgs[5]!.result.structuredContent.ok).toBe(true);
  }, 30_000);
});

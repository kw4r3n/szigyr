import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, describe, expect, it } from "vitest";
import { buildBrowser, buildNode, check, queryFile, run, runTestFile, type Backend } from "../src/index.ts";
import { mutateFile } from "../src/mutate.ts";

const EXAMPLE_DIR = resolve(import.meta.dirname, "../../../examples/retouch");
const MAIN_SZIGYR = join(EXAMPLE_DIR, "main.szigyr");
const KERNELS_SZIGYR = join(EXAMPLE_DIR, "kernels.szigyr");
const UI_DIR = join(EXAMPLE_DIR, "ui");
const CLI_PATH = resolve(import.meta.dirname, "../src/cli.ts");

const tmpRoots: string[] = [];
function makeTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

function findPlaywright(): { launch: (opts?: Record<string, unknown>) => Promise<any> } | null {
  try {
    const req = createRequire(import.meta.url);
    const pw = (() => {
      try {
        return req("playwright");
      } catch {
        const bin = execFileSync("which", ["playwright"], { encoding: "utf8" }).trim();
        return createRequire(bin)(resolve(dirname(bin), "..", "playwright"));
      }
    })();
    let executablePath: string | undefined;
    try {
      const def = pw.chromium.executablePath();
      if (!existsSync(def)) {
        const cache = join(homedir(), ".cache/ms-playwright");
        if (existsSync(cache)) {
          const dir = readdirSync(cache).filter((d) => d.startsWith("chromium-")).sort().at(-1);
          if (dir) {
            executablePath = [
              join(cache, dir, "chrome-linux64/chrome"),
              join(cache, dir, "chrome-linux/chrome"),
            ].find((p) => existsSync(p));
          }
        }
      } else {
        executablePath = def;
      }
    } catch {
      /* fallback */
    }
    if (!executablePath) return null;
    return { launch: (opts) => pw.chromium.launch({ executablePath, ...opts }) };
  } catch {
    return null;
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".wasm": "application/wasm",
};

async function serveDir(dir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const srv: Server = createServer((req, res) => {
    const u = (req.url ?? "/").split("?")[0]!;
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    const rel = u === "/" ? "index.html" : u.replace(/^\/+/, "");
    const abs = resolve(dir, rel);
    if (!abs.startsWith(resolve(dir)) || !existsSync(abs)) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[extname(abs)] ?? "application/octet-stream" });
    res.end(readFileSync(abs));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const addr = srv.address() as { port: number };
  return { url: `http://127.0.0.1:${addr.port}`, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

describe("examples/retouch real-app dogfood verification", () => {
  it("passes check with zero diagnostics and exposes expected rt/Mutatable symbols via queryFile", () => {
    const diags = check(MAIN_SZIGYR);
    expect(diags).toEqual([]);

    const qKernels = queryFile(KERNELS_SZIGYR);
    expect(qKernels.diagnostics).toEqual([]);
    const passSym = qKernels.symbols.find((s) => s.name === "frequencySeparatePass");
    expect(passSym).toMatchObject({ kind: "function", layer: "rt", pure: true, mutatable: true });
    const strokeSym = qKernels.symbols.find((s) => s.name === "applyBrushStroke");
    expect(strokeSym).toMatchObject({ kind: "function", layer: "rt", pure: true, mutatable: true });

    const qMain = queryFile(MAIN_SZIGYR);
    expect(qMain.diagnostics).toEqual([]);
    const mainSym = qMain.symbols.find((s) => s.name === "main");
    expect(mainSym).toMatchObject({ kind: "function", layer: "managed", pure: false, mutatable: false });
  });

  it("passes all colocated unit and forAll tests identically across js, c, and wasm", async () => {
    const backends: Backend[] = ["js", "c", "wasm"];
    const results = [];
    for (const backend of backends) {
      const r = await runTestFile(MAIN_SZIGYR, { backend });
      expect(r.diagnostics, `diagnostics for ${backend}`).toEqual([]);
      expect(r.results.length).toBeGreaterThanOrEqual(11);
      for (const t of r.results) {
        expect(t.ok, `${backend} test ${t.name}: ${t.failure ?? ""}`).toBe(true);
      }
      results.push(r.results.map((t) => t.name));
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  }, 120_000);

  it("executes main (including Spawn isolate + Vec + Arena + u64 FNV-1a) identically across js, c, and wasm", async () => {
    const outs: string[] = [];
    for (const backend of ["js", "c", "wasm"] as const) {
      const r = await run(MAIN_SZIGYR, { backend });
      expect(r.diagnostics).toEqual([]);
      expect(r.trap).toBeNull();
      expect(r.stdout).toContain(":parity=true\n");
      outs.push(r.stdout);
    }
    expect(outs[1]).toBe(outs[0]);
    expect(outs[2]).toBe(outs[0]);
  }, 120_000);

  it("achieves zero surviving mutants across all retouch modules via mutateFile --all", async () => {
    const res = await mutateFile(MAIN_SZIGYR, { all: true, cache: false });
    expect(res.diagnostics).toEqual([]);
    expect(res.baselineFailure).toBeNull();
    expect(res.summary.targets).toBeGreaterThan(25);
    expect(res.summary.killed).toBeGreaterThan(400);
    expect(res.summary.survived).toBe(0);
  }, 120_000);

  it("builds standalone native Node app (--target=node) and matches run output after relocation", async () => {
    const ref = await run(MAIN_SZIGYR, { backend: "c" });
    const outDir = makeTmp("szigyr-retouch-node-");
    const built = buildNode(MAIN_SZIGYR, { outDir });
    expect(built.diagnostics).toEqual([]);
    expect(built.files).toContain("program.node");
    expect(built.files).toContain("main.js");

    const relocated = makeTmp("szigyr-retouch-reloc-");
    cpSync(outDir, relocated, { recursive: true });
    const stdout = execFileSync(process.execPath, [join(relocated, "main.js")], {
      cwd: relocated,
      encoding: "utf8",
    });
    expect(stdout).toBe(ref.stdout);
  }, 120_000);

  const pw = findPlaywright();
  it.skipIf(!pw)("runs --target=browser --mode=lib interactive canvas UI + Web Worker Wasm in Chromium", async () => {
    const siteDir = makeTmp("szigyr-retouch-web-");
    cpSync(join(UI_DIR, "index.html"), join(siteDir, "index.html"));
    cpSync(join(UI_DIR, "ui.js"), join(siteDir, "ui.js"));
    const distDir = join(siteDir, "dist");
    mkdirSync(distDir, { recursive: true });

    const built = buildBrowser(MAIN_SZIGYR, { outDir: distDir, mode: "lib" });
    expect(built.diagnostics).toEqual([]);
    expect(built.files).toContain("program.wasm");
    expect(built.files).toContain("app.js");

    const srv = await serveDir(siteDir);
    const browser = await pw!.launch();
    try {
      const page = await browser.newPage();
      const pageErrors: string[] = [];
      page.on("pageerror", (e: Error) => pageErrors.push(String(e)));

      await page.goto(srv.url, { waitUntil: "load" });
      await page.waitForFunction(() => document.getElementById("stats")?.dataset.status === "ready", undefined, { timeout: 20_000 });

      const initSnap = await page.evaluate(() => {
        const stats = document.getElementById("stats")!;
        const c = document.getElementById("canvas") as HTMLCanvasElement;
        const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
        let allAlpha255 = true;
        let minR = 255, maxR = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] !== 255) allAlpha255 = false;
          if (d[i]! < minR) minR = d[i]!;
          if (d[i]! > maxR) maxR = d[i]!;
        }
        return {
          len: d.length,
          allAlpha255,
          nonUniform: maxR > minR,
          fnv64: stats.dataset.fnv64,
          undoDepth: stats.dataset.undoDepth,
        };
      });
      expect(initSnap.len).toBe(96 * 96 * 4);
      expect(initSnap.allAlpha255).toBe(true);
      expect(initSnap.nonUniform).toBe(true);
      expect(initSnap.undoDepth).toBe("0");

      const box = await page.locator("#canvas").boundingBox();
      expect(box).not.toBeNull();
      await page.mouse.move(box!.x + box!.width * 0.35, box!.y + box!.height * 0.42);
      await page.mouse.down();
      await page.mouse.move(box!.x + box!.width * 0.55, box!.y + box!.height * 0.58, { steps: 3 });
      await page.mouse.up();
      await page.waitForFunction(() => document.getElementById("stats")?.dataset.status === "stroke:smooth", undefined, { timeout: 10_000 });

      const afterStroke = await page.evaluate(() => {
        const stats = document.getElementById("stats")!;
        const c = document.getElementById("canvas") as HTMLCanvasElement;
        const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
        let allAlpha255 = true;
        for (let i = 0; i < d.length; i += 4) if (d[i + 3] !== 255) allAlpha255 = false;
        return { fnv64: stats.dataset.fnv64, undoDepth: Number(stats.dataset.undoDepth), allAlpha255 };
      });
      expect(afterStroke.fnv64).not.toBe(initSnap.fnv64);
      expect(afterStroke.undoDepth).toBeGreaterThanOrEqual(1);
      expect(afterStroke.allAlpha255).toBe(true);

      await page.click("#btn-freq-worker");
      await page.waitForFunction(() => document.getElementById("stats")?.dataset.status === "freq:worker", undefined, { timeout: 20_000 });
      const afterWorker = await page.evaluate(() => {
        const stats = document.getElementById("stats")!;
        return { fnv64: stats.dataset.fnv64, undoDepth: Number(stats.dataset.undoDepth) };
      });
      expect(afterWorker.fnv64).not.toBe(afterStroke.fnv64);
      expect(afterWorker.undoDepth).toBe(afterStroke.undoDepth + 1);

      await page.click("#btn-undo");
      await page.waitForFunction(() => document.getElementById("stats")?.dataset.status === "undo", undefined, { timeout: 10_000 });
      const afterUndo = await page.evaluate(() => document.getElementById("stats")!.dataset.fnv64);
      expect(afterUndo).toBe(afterStroke.fnv64);

      const hostRoundtrip = await page.evaluate(async () => {
        const dynImport = new Function("p", "return import(p)") as (p: string) => Promise<any>;
        const { load } = await dynImport("./dist/app.js");
        const { exports, createSystem, Vec } = await load();
        const sys = createSystem();
        const raw = new Uint8ClampedArray([
          10, 20, 30, 255, 40, 50, 60, 255,
          70, 80, 90, 255, 100, 110, 120, 255,
        ]);
        const v = Vec.fromTypedArray(sys.alloc, raw, "u8");
        const s = exports.createSession(sys.alloc, 2, 2, 1, v);
        const ta = s.snapshotRgba(sys.alloc).asTypedArray();
        s.dispose();
        return { isUint8: ta instanceof Uint8Array, bytes: Array.from(ta) };
      });
      expect(hostRoundtrip.isUint8).toBe(true);
      expect(hostRoundtrip.bytes).toEqual([
        10, 20, 30, 255, 40, 50, 60, 255,
        70, 80, 90, 255, 100, 110, 120, 255,
      ]);
      expect(pageErrors).toEqual([]);
    } finally {
      await browser.close();
      await srv.close();
    }
  }, 60_000);

  it("works cleanly via szigyr mcp stdio server including unsaved overlays", async () => {
    const child = spawn(process.execPath, [CLI_PATH, "mcp"], { stdio: ["pipe", "pipe", "pipe"] });
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const queue: Record<string, any>[] = [];
    const waiters: ((msg: Record<string, any>) => void)[] = [];
    rl.on("line", (line) => {
      if (!line.trim()) return;
      const obj = JSON.parse(line) as Record<string, any>;
      const w = waiters.shift();
      if (w) w(obj);
      else queue.push(obj);
    });
    const nextResp = (): Promise<Record<string, any>> =>
      queue.length ? Promise.resolve(queue.shift()!) : new Promise((r) => waiters.push(r));
    const rpc = async (msg: unknown) => {
      child.stdin.write(`${JSON.stringify(msg)}\n`);
      return await nextResp();
    };

    try {
      const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
      expect(init.result.serverInfo.name).toBe("szigyr");
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

      const chk = await rpc({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "szigyr_check", arguments: { file: MAIN_SZIGYR } },
      });
      expect(chk.result.structuredContent).toMatchObject({ ok: true, diagnostics: [] });

      const qry = await rpc({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "szigyr_query", arguments: { file: KERNELS_SZIGYR } },
      });
      expect(qry.result.structuredContent.ok).toBe(true);
      expect(qry.result.structuredContent.symbols.find((s: Record<string, unknown>) => s.name === "clampU8")).toMatchObject({
        layer: "rt",
        pure: true,
        mutatable: true,
      });

      const badOverlay = readFileSync(KERNELS_SZIGYR, "utf8").replace(
        "return u8(Math.round(x));",
        "return x;",
      );
      const chkOverlay = await rpc({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "szigyr_check",
          arguments: {
            file: MAIN_SZIGYR,
            overlays: { [KERNELS_SZIGYR]: badOverlay },
          },
        },
      });
      expect(chkOverlay.result.structuredContent.ok).toBe(false);
      expect(chkOverlay.result.structuredContent.diagnostics[0].code).toBe("E2002");

      // Unsaved overlay must not leak into subsequent disk checks.
      const chkClean = await rpc({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "szigyr_check", arguments: { file: MAIN_SZIGYR } },
      });
      expect(chkClean.result.structuredContent).toMatchObject({ ok: true, diagnostics: [] });
    } finally {
      rl.close();
      child.stdin.end();
      await new Promise<void>((r) => child.once("close", () => r()));
    }
  }, 30_000);
});

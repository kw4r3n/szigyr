import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildBrowser, buildNode, check, queryFile, run, runTestFile } from "../src/index.ts";
import { mutateFile } from "../src/mutate.ts";

const MICRODAW_DIR = resolve(import.meta.dirname, "../../../examples/microdaw");
const APP_SZIGYR = join(MICRODAW_DIR, "app.szigyr");

const tmpRoots: string[] = [];
function makeTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

function hasSdl3Runtime(): boolean {
  const r = spawnSync("python3", ["-c", 'import ctypes; ctypes.CDLL("libSDL3.so.0")'], { stdio: "ignore" });
  return r.status === 0;
}

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

async function serveDir(dir: string): Promise<{ url: string; notFound: string[]; close: () => Promise<void> }> {
  const notFound: string[] = [];
  const srv: Server = createServer((req, res) => {
    const u = (req.url ?? "/").split("?")[0]!;
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    if (u === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    const rel = u === "/" ? "index.html" : u.replace(/^\/+/, "");
    const abs = resolve(dir, rel);
    if (!abs.startsWith(resolve(dir)) || !existsSync(abs)) {
      notFound.push(u);
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[extname(abs)] ?? "application/octet-stream" });
    res.end(readFileSync(abs));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const addr = srv.address() as { port: number };
  return { url: `http://127.0.0.1:${addr.port}`, notFound, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

function assertNonSilentFloat32Pcm(buf: Buffer): void {
  expect(buf.byteLength).toBeGreaterThanOrEqual(4096);
  const floats = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  let peak = 0;
  for (let i = 0; i < floats.length; i++) {
    const s = floats[i]!;
    expect(Number.isFinite(s)).toBe(true);
    const a = Math.abs(s);
    if (a > peak) peak = a;
  }
  expect(peak).toBeGreaterThan(0.01);
}

describe("examples/microdaw/app.szigyr pure-Szigyr Display + Audio DAW", () => {
  it("passes check, exposes metadata, and matches colocated tests identically across js, c, and wasm", async () => {
    expect(check(APP_SZIGYR)).toEqual([]);
    const q = queryFile(APP_SZIGYR);
    expect(q.diagnostics).toEqual([]);
    expect(q.symbols.find((s) => s.name === "parseDawArgs")).toMatchObject({ deterministic: true, mutatable: true });

    const names: string[][] = [];
    for (const backend of ["js", "c", "wasm"] as const) {
      const r = await runTestFile(APP_SZIGYR, { backend });
      expect(r.diagnostics, backend).toEqual([]);
      expect(r.results.length).toBeGreaterThanOrEqual(3);
      for (const t of r.results) expect(t.ok, `${backend} ${t.name}: ${t.failure ?? ""}`).toBe(true);
      names.push(r.results.map((t) => t.name));
    }
    expect(names[1]).toEqual(names[0]);
    expect(names[2]).toEqual(names[0]);
  }, 120_000);

  it("achieves zero surviving mutants on examples/microdaw/app.szigyr", async () => {
    const res = await mutateFile(APP_SZIGYR, { cache: false });
    expect(res.diagnostics).toEqual([]);
    expect(res.baselineFailure).toBeNull();
    expect(res.summary.killed).toBeGreaterThan(250);
    expect(res.summary.survived).toBe(0);
  }, 180_000);

  it.skipIf(!hasSdl3Runtime())("runs simultaneous SDL3 Video (dummy) + Audio (disk) in run(--backend=c) and relocated buildNode(--target=node)", async () => {
    const pcmDir = makeTmp("szigyr-microdaw-sdl-");
    const rawA = join(pcmDir, "run.raw");
    const rawB = join(pcmDir, "reloc.raw");

    const prevV = process.env.SDL_VIDEODRIVER;
    const prevA = process.env.SDL_AUDIO_DRIVER;
    const prevF = process.env.SDL_AUDIO_DISK_OUTPUT_FILE;
    process.env.SDL_VIDEODRIVER = "dummy";
    process.env.SDL_AUDIO_DRIVER = "disk";
    process.env.SDL_AUDIO_DISK_OUTPUT_FILE = rawA;
    try {
      const r = await run(APP_SZIGYR, { backend: "c", args: ["--frames=4", "--autoplay"] });
      expect(r.diagnostics).toEqual([]);
      expect(r.trap).toBeNull();
      expect(r.stdout).toMatch(/^microdaw:frames=4:audio=true:step=\d+:peak=\d+\n$/);
    } finally {
      if (prevV === undefined) delete process.env.SDL_VIDEODRIVER;
      else process.env.SDL_VIDEODRIVER = prevV;
      if (prevA === undefined) delete process.env.SDL_AUDIO_DRIVER;
      else process.env.SDL_AUDIO_DRIVER = prevA;
      if (prevF === undefined) delete process.env.SDL_AUDIO_DISK_OUTPUT_FILE;
      else process.env.SDL_AUDIO_DISK_OUTPUT_FILE = prevF;
    }
    assertNonSilentFloat32Pcm(readFileSync(rawA));

    const outDir = makeTmp("szigyr-microdaw-node-build-");
    const built = buildNode(APP_SZIGYR, { outDir, backend: "c" });
    expect(built.diagnostics).toEqual([]);
    expect(built.files).toContain("program.node");
    expect(built.files).toContain("display.node");
    expect(built.files).toContain("main.js");

    const relocDir = makeTmp("szigyr-microdaw-reloc-");
    cpSync(outDir, relocDir, { recursive: true });
    rmSync(outDir, { recursive: true, force: true });

    const out = execFileSync(process.execPath, [join(relocDir, "main.js"), "--frames=4", "--autoplay"], {
      cwd: relocDir,
      encoding: "utf8",
      env: {
        ...process.env,
        SDL_VIDEODRIVER: "dummy",
        SDL_AUDIO_DRIVER: "disk",
        SDL_AUDIO_DISK_OUTPUT_FILE: rawB,
      },
    });
    expect(out).toMatch(/^microdaw:frames=4:audio=true:step=\d+:peak=\d+\n$/);
    assertNonSilentFloat32Pcm(readFileSync(rawB));
  }, 120_000);

  const pw = findPlaywright();
  it.skipIf(!pw)("runs build --target=browser --mode=app pure-Szigyr MicroDAW (Canvas 2D + AudioWorklet Wasm) in Chromium", async () => {
    const distDir = makeTmp("szigyr-microdaw-web-app-");
    const built = buildBrowser(APP_SZIGYR, { outDir: distDir, mode: "app" });
    expect(built.diagnostics).toEqual([]);
    expect(built.files).toContain("index.html");
    expect(built.files).toContain("program.wasm");
    expect(built.files).toContain("szigyr-worklet.js");

    const srv = await serveDir(distDir);
    const browser = await pw!.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
    try {
      const page = await browser.newPage();
      const pageErrors: string[] = [];
      const consoleErrors: string[] = [];
      page.on("pageerror", (e: Error) => pageErrors.push(String(e)));
      page.on("console", (msg: { type: () => string; text: () => string }) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
      });

      await page.goto(srv.url, { waitUntil: "load" });
      await page.click("#start");
      const canvas = page.locator("#szigyr-canvas");
      await canvas.waitFor({ state: "visible", timeout: 20_000 });

      const size = await page.evaluate(() => {
        const c = document.getElementById("szigyr-canvas") as HTMLCanvasElement;
        return { width: c.width, height: c.height };
      });
      expect(size).toEqual({ width: 540, height: 360 });

      const hashCanvas = () => page.evaluate(() => {
        const c = document.getElementById("szigyr-canvas") as HTMLCanvasElement;
        const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
        let h = 2166136261;
        for (let i = 0; i < d.length; i += 4) {
          h = Math.imul(h ^ d[i]!, 16777619) >>> 0;
          h = Math.imul(h ^ d[i + 1]!, 16777619) >>> 0;
          h = Math.imul(h ^ d[i + 2]!, 16777619) >>> 0;
        }
        return h >>> 0;
      });
      const h0 = await hashCanvas();

      // Press Space to open AudioWorklet Wasm + start sequencer; telemetry updates playhead/scope
      await page.keyboard.press("Space");
      await page.waitForFunction((prev: number) => {
        const c = document.getElementById("szigyr-canvas") as HTMLCanvasElement;
        if (!c) return false;
        const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
        let h = 2166136261;
        for (let i = 0; i < d.length; i += 4) {
          h = Math.imul(h ^ d[i]!, 16777619) >>> 0;
          h = Math.imul(h ^ d[i + 1]!, 16777619) >>> 0;
          h = Math.imul(h ^ d[i + 2]!, 16777619) >>> 0;
        }
        return (h >>> 0) !== prev;
      }, h0, { timeout: 20_000 });

      // Click grid cell (col=1, row=2), press '2' (SQR) and 'a' (pad), then let frames render
      const box = await canvas.boundingBox();
      expect(box).not.toBeNull();
      const sx = box!.width / 540;
      const sy = box!.height / 360;
      await page.mouse.click(box!.x + (48 + 45) * sx, box!.y + (44 + 50) * sy);
      await page.keyboard.press("2");
      await page.keyboard.press("a");
      await page.waitForTimeout(180);

      // Escape exits cleanly, closing AudioWorklet + Canvas
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => {
        const out = document.getElementById("out")?.textContent ?? "";
        return out.includes("Done.") && !document.getElementById("szigyr-canvas");
      }, undefined, { timeout: 15_000 });

      const outText = await page.locator("#out").textContent();
      expect(outText).toMatch(/microdaw:frames=\d+:audio=true:/);
      expect(pageErrors).toEqual([]);
      expect(consoleErrors).toEqual([]);
      expect(srv.notFound).toEqual([]);
    } finally {
      await browser.close();
      await srv.close();
    }
  }, 60_000);
});

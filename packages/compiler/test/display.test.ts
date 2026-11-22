import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildBrowser, buildNode, check, run, runTestFile, type Backend } from "../src/index.ts";
import { mutateFile } from "../src/mutate.ts";

const APP_SZIGYR = resolve(import.meta.dirname, "../../../examples/retouch/app.szigyr");

const tmpRoots: string[] = [];
function makeTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

function checkSrc(src: string) {
  const dir = makeTmp("szigyr-display-chk-");
  const file = join(dir, "main.szigyr");
  writeFileSync(file, src);
  return check(file);
}

async function runSrc(src: string, backend: Backend) {
  const dir = makeTmp("szigyr-display-run-");
  const file = join(dir, "main.szigyr");
  writeFileSync(file, src);
  return await run(file, { backend });
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
  ".css": "text/css; charset=utf-8",
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

function hasSdl3Runtime(): boolean {
  const r = spawnSync("python3", ["-c", 'import ctypes; ctypes.CDLL("libSDL3.so.0")'], { stdio: "ignore" });
  return r.status === 0;
}

describe("Display & Input capability (Q279)", () => {
  it("enforces managedOnly / rt authority rules, AsyncDisposable await using, exhaustive DisplayEvent switch, and Vec->Ref<Slice<u8>>", () => {
    const okDiags = checkSrc(`
export async function okUse(sys: System, px: Vec<u8>): Promise<string> {
  const r = await sys.display.open({ title: "OK", width: 32, height: 24 });
  if (r.kind === "err") return r.error.code;
  await using surf = r.value;
  surf.blitRgba(px, 1, 1, 0, 0, 1, 1);
  let last = "";
  for (const ev of surf.pollEvents()) {
    switch (ev.kind) {
      case "pointerDown": last = \`down:\${ev.button}\`; break;
      case "pointerMove": last = \`move:\${ev.buttons}\`; break;
      case "pointerUp": last = \`up:\${ev.button}\`; break;
      case "wheel": last = \`wheel:\${ev.dy}\`; break;
      case "keyDown": last = \`kd:\${ev.key}:\${ev.repeat}\`; break;
      case "keyUp": last = \`ku:\${ev.key}\`; break;
      case "close": last = "close"; break;
    }
  }
  await surf.present();
  return last;
}
`);
    expect(okDiags).toEqual([]);

    const badOwned = checkSrc(`
export function badStrict(d: Display): void {
  "use owned";
  const _r = d.open({ title: "x", width: 10, height: 10 });
}
export function badSurf(s: DisplaySurface): void {
  "use owned";
  s.clear({ r: 0, g: 0, b: 0, a: 255 });
}
export function badFake(): void {
  "use owned";
  const _f = FakeDisplay.create();
}
export function badContract(s: DisplaySurface): i32 {
  requires(((): boolean => { s.clear({ r: 0, g: 0, b: 0, a: 255 }); return true; })());
  return 1;
}
`);
    const badCodes = badOwned.map((d) => `${d.range.start.line}:${d.code}`);
    expect(badCodes).toContain("4:E4001");
    expect(badCodes).toContain("8:E4001");
    expect(badCodes).toContain("12:E4001");
    expect(badCodes).toContain("15:E6002");

    const badRt = checkSrc(`
export function badRt(d: Display, s: DisplaySurface, f: FakeDisplay): void {
  "use rt";
}
`);
    expect(badRt.map((d) => d.code)).toEqual(["E4006", "E4002", "E4002"]);
  });

  it("traps T002 consistently across js, c, and wasm when blitRgba buffer is smaller than srcWidth*srcHeight*4", async () => {
    const src = `
export async function main(sys: System): Promise<void> {
  const disp = FakeDisplay.create();
  const res = await disp.open({ title: "Trap", width: 16, height: 16 });
  if (res.kind !== "ok") return;
  await using surf = res.value;
  const small = Vec.filled<u8>(sys.alloc, 12, 255);
  surf.blitRgba(small, 2, 2, 0, 0, 2, 2);
}
`;
    for (const backend of ["js", "c", "wasm"] as const) {
      const r = await runSrc(src, backend);
      expect(r.diagnostics).toEqual([]);
      expect(r.trap?.code, backend).toBe("T002");
      expect(r.trap?.line, backend).toBe(8);
    }
  }, 60_000);

  it("runs examples/retouch/app.szigyr colocated tests identically across js, c, and wasm", async () => {
    const results: string[][] = [];
    for (const backend of ["js", "c", "wasm"] as const) {
      const r = await runTestFile(APP_SZIGYR, { backend });
      expect(r.diagnostics, backend).toEqual([]);
      expect(r.results.length).toBeGreaterThanOrEqual(5);
      for (const t of r.results) {
        expect(t.ok, `${backend} ${t.name}: ${t.failure ?? ""}`).toBe(true);
      }
      results.push(r.results.map((t) => t.name));
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  }, 120_000);

  it("achieves zero surviving mutants on examples/retouch/app.szigyr", async () => {
    const res = await mutateFile(APP_SZIGYR, { cache: false });
    expect(res.diagnostics).toEqual([]);
    expect(res.baselineFailure).toBeNull();
    expect(res.summary.killed).toBeGreaterThan(200);
    expect(res.summary.survived).toBe(0);
  }, 120_000);

  it.skipIf(!hasSdl3Runtime())("runs Node SDL3 Display E2E (SDL_VIDEODRIVER=dummy) via run(--backend=c) and relocated buildNode(--target=node)", async () => {
    const prevDrv = process.env.SDL_VIDEODRIVER;
    process.env.SDL_VIDEODRIVER = "dummy";
    let refOut = "";
    try {
      const r = await run(APP_SZIGYR, { backend: "c", args: ["--frames=2"] });
      expect(r.diagnostics).toEqual([]);
      expect(r.trap).toBeNull();
      expect(r.stdout).toMatch(/^retouch:frames=2:undo=0:fnv=\d+\n$/);
      refOut = r.stdout;
    } finally {
      if (prevDrv === undefined) delete process.env.SDL_VIDEODRIVER;
      else process.env.SDL_VIDEODRIVER = prevDrv;
    }

    const outDir = makeTmp("szigyr-display-node-");
    const built = buildNode(APP_SZIGYR, { outDir, backend: "c" });
    expect(built.diagnostics).toEqual([]);
    expect(built.files).toContain("program.node");
    expect(built.files).toContain("display.node");
    expect(built.files).toContain("main.js");

    const relocDir = makeTmp("szigyr-display-reloc-");
    cpSync(outDir, relocDir, { recursive: true });
    rmSync(outDir, { recursive: true, force: true });

    const stdout = execFileSync(process.execPath, [join(relocDir, "main.js"), "--frames=2"], {
      cwd: relocDir,
      encoding: "utf8",
      env: { ...process.env, SDL_VIDEODRIVER: "dummy" },
    });
    expect(stdout).toBe(refOut);
  }, 120_000);

  const pw = findPlaywright();
  it.skipIf(!pw)("runs build --target=browser --mode=app pure-Szigyr Retouch Studio via Canvas 2D + Web Worker Wasm in Chromium", async () => {
    const distDir = makeTmp("szigyr-display-browser-");
    const built = buildBrowser(APP_SZIGYR, { outDir: distDir, mode: "app" });
    expect(built.diagnostics).toEqual([]);
    expect(built.files).toContain("index.html");
    expect(built.files).toContain("program.wasm");

    const srv = await serveDir(distDir);
    const browser = await pw!.launch();
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

      const initSnap = await page.evaluate(() => {
        const c = document.getElementById("szigyr-canvas") as HTMLCanvasElement;
        const ctx = c.getContext("2d")!;
        const d = ctx.getImageData(16, 44, 288, 288).data;
        let minR = 255, maxR = 0, allOpaque = true;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] !== 255) allOpaque = false;
          if (d[i]! < minR) minR = d[i]!;
          if (d[i]! > maxR) maxR = d[i]!;
        }
        return {
          width: c.width,
          height: c.height,
          allOpaque,
          nonUniform: maxR > minR,
          hash: Array.from(d.subarray(0, 4096)).reduce((h, v) => ((h * 33) ^ v) >>> 0, 5381),
        };
      });
      expect(initSnap.width).toBe(320);
      expect(initSnap.height).toBe(360);
      expect(initSnap.allOpaque).toBe(true);
      expect(initSnap.nonUniform).toBe(true);

      // Install window helper to read full 288x288 portrait ROI hash quickly
      const roiHash = () => page.evaluate(() => {
        const c = document.getElementById("szigyr-canvas") as HTMLCanvasElement;
        const d = c.getContext("2d")!.getImageData(16, 44, 288, 288).data;
        let h = 2166136261;
        for (let i = 0; i < d.length; i += 4) {
          h = Math.imul(h ^ d[i]!, 16777619) >>> 0;
          h = Math.imul(h ^ d[i + 1]!, 16777619) >>> 0;
          h = Math.imul(h ^ d[i + 2]!, 16777619) >>> 0;
        }
        return h >>> 0;
      });
      const h0 = await roiHash();

      const box = await canvas.boundingBox();
      expect(box).not.toBeNull();
      const sx = box!.width / 320;
      const sy = box!.height / 360;

      // Paint drag stroke in viewport, then park cursor in outer margin so hover box does not overlay portrait ROI
      await page.mouse.move(box!.x + 100 * sx, box!.y + 120 * sy);
      await page.mouse.down();
      await page.mouse.move(box!.x + 180 * sx, box!.y + 200 * sy, { steps: 4 });
      await page.mouse.up();
      await page.mouse.move(box!.x + 2 * sx, box!.y + 180 * sy);

      await page.waitForFunction((prevHash: number) => {
        const c = document.getElementById("szigyr-canvas") as HTMLCanvasElement;
        if (!c) return false;
        const d = c.getContext("2d")!.getImageData(16, 44, 288, 288).data;
        let h = 2166136261;
        for (let i = 0; i < d.length; i += 4) {
          h = Math.imul(h ^ d[i]!, 16777619) >>> 0;
          h = Math.imul(h ^ d[i + 1]!, 16777619) >>> 0;
          h = Math.imul(h ^ d[i + 2]!, 16777619) >>> 0;
        }
        return (h >>> 0) !== prevHash;
      }, h0, { timeout: 10_000 });
      await page.waitForTimeout(80);
      const hStroke = await roiHash();
      expect(hStroke).not.toBe(h0);

      // Trigger Web Worker Wasm frequency pass via 'f' key
      await page.keyboard.press("f");
      await page.waitForFunction((prevHash: number) => {
        const c = document.getElementById("szigyr-canvas") as HTMLCanvasElement;
        if (!c) return false;
        const d = c.getContext("2d")!.getImageData(16, 44, 288, 288).data;
        let h = 2166136261;
        for (let i = 0; i < d.length; i += 4) {
          h = Math.imul(h ^ d[i]!, 16777619) >>> 0;
          h = Math.imul(h ^ d[i + 1]!, 16777619) >>> 0;
          h = Math.imul(h ^ d[i + 2]!, 16777619) >>> 0;
        }
        return (h >>> 0) !== prevHash;
      }, hStroke, { timeout: 20_000 });
      const hFreq = await roiHash();
      expect(hFreq).not.toBe(hStroke);

      // Undo via 'z' key -> reverts portrait ROI pixels cleanly back to post-stroke hash
      await page.keyboard.press("z");
      await page.waitForFunction((wantHash: number) => {
        const c = document.getElementById("szigyr-canvas") as HTMLCanvasElement;
        if (!c) return false;
        const d = c.getContext("2d")!.getImageData(16, 44, 288, 288).data;
        let h = 2166136261;
        for (let i = 0; i < d.length; i += 4) {
          h = Math.imul(h ^ d[i]!, 16777619) >>> 0;
          h = Math.imul(h ^ d[i + 1]!, 16777619) >>> 0;
          h = Math.imul(h ^ d[i + 2]!, 16777619) >>> 0;
        }
        return (h >>> 0) === wantHash;
      }, hStroke, { timeout: 10_000 });

      // Exit studio cleanly via Escape key and confirm canvas removed + #out reports Done.
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => {
        const out = document.getElementById("out")?.textContent ?? "";
        return out.includes("Done.") && !document.getElementById("szigyr-canvas");
      }, undefined, { timeout: 10_000 });
      const outText = await page.locator("#out").textContent();
      expect(outText).toContain("retouch:frames=");
      expect(pageErrors).toEqual([]);
      expect(consoleErrors).toEqual([]);
      expect(srv.notFound).toEqual([]);
    } finally {
      await browser.close();
      await srv.close();
    }
  }, 60_000);
});

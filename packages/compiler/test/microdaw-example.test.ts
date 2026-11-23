import { execFile, execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { analyze, buildBrowser, buildNode, check, prove, queryFile, runTestFile, type Backend } from "../src/index.ts";
import { mutateFile } from "../src/mutate.ts";

const execFileAsync = promisify(execFile);

const MICRODAW_DIR = resolve(import.meta.dirname, "../../../examples/microdaw");
const DSP_SZIGYR = join(MICRODAW_DIR, "dsp.szigyr");
const ENGINE_SZIGYR = join(MICRODAW_DIR, "engine.szigyr");
const DESKTOP_CORE_SZIGYR = join(MICRODAW_DIR, "desktop-core.szigyr");
const DESKTOP_SZIGYR = join(MICRODAW_DIR, "desktop.szigyr");
const UI_DIR = join(MICRODAW_DIR, "ui");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
};

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

function hasWebKitGtkAndXvfb(): boolean {
  const pc = spawnSync("pkg-config", ["--exists", "webkit2gtk-4.1"]);
  const xvfb = spawnSync("which", ["xvfb-run"]);
  return pc.status === 0 && xvfb.status === 0;
}

const CAPTURE_WORKLET_JS = `
class CaptureWorklet extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    if (inp && inp.length >= 2 && inp[0].length > 0) {
      const n = inp[0].length;
      const inter = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        inter[i * 2] = inp[0][i];
        inter[i * 2 + 1] = inp[1][i];
      }
      this.port.postMessage(inter, [inter.buffer]);
      for (let ch = 0; ch < out.length; ch++) {
        if (inp[ch]) out[ch].set(inp[ch]);
      }
    }
    return true;
  }
}
registerProcessor("capture-worklet", CaptureWorklet);
`;

async function serveDir(dir: string, coi: boolean): Promise<{ url: string; notFound: string[]; close: () => Promise<void> }> {
  const notFound: string[] = [];
  const srv: Server = createServer((req, res) => {
    const u = (req.url ?? "/").split("?")[0]!;
    if (coi) {
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    }
    if (u === "/capture-worklet.js") {
      res.writeHead(200, { "content-type": MIME[".js"]! });
      res.end(CAPTURE_WORKLET_JS);
      return;
    }
    const rel = u === "/" ? "index.html" : u.replace(/^\/+/, "");
    const abs = resolve(dir, rel);
    if (!abs.startsWith(resolve(dir)) || !existsSync(abs)) {
      notFound.push(req.url ?? "/");
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

const pw = findPlaywright();
const canWebKit = hasWebKitGtkAndXvfb();

describe("examples/microdaw compiler, proof, parity, and mutation verification", () => {
  it("passes check and exposes expected layers, deterministic flags, and mutatable metadata", () => {
    expect(check(ENGINE_SZIGYR)).toEqual([]);
    expect(check(DESKTOP_CORE_SZIGYR)).toEqual([]);

    const qDsp = queryFile(DSP_SZIGYR);
    expect(qDsp.diagnostics).toEqual([]);
    for (const fn of ["bpmToSamplesPerStep", "midiToFreq", "clampF32", "oscSample"]) {
      expect(qDsp.symbols.find((s) => s.name === fn)).toMatchObject({
        kind: "function",
        layer: "rt",
        deterministic: true,
        mutatable: true,
      });
    }
    for (const fn of ["triggerVoice", "applyCmd", "renderAudio"]) {
      expect(qDsp.symbols.find((s) => s.name === fn)).toMatchObject({
        kind: "function",
        layer: "rt",
        deterministic: false,
        mutatable: true,
      });
    }
    expect(qDsp.symbols.find((s) => s.name === "createInitialSynthState")).toMatchObject({
      kind: "function",
      layer: "strict",
      deterministic: false,
      mutatable: true,
    });

    const qEng = queryFile(ENGINE_SZIGYR);
    expect(qEng.diagnostics).toEqual([]);
    expect(qEng.symbols.find((s) => s.name === "presetSteps")).toMatchObject({
      kind: "function",
      layer: "managed",
      deterministic: true,
      mutatable: true,
    });
    expect(qEng.symbols.find((s) => s.name === "renderOfflinePreview")).toMatchObject({
      kind: "function",
      layer: "managed",
      deterministic: false,
      mutatable: true,
    });

    const qDc = queryFile(DESKTOP_CORE_SZIGYR);
    expect(qDc.diagnostics).toEqual([]);
    for (const fn of ["mimeTypeForPath", "sanitizeAssetPath", "parseDesktopArgs"]) {
      expect(qDc.symbols.find((s) => s.name === fn)).toMatchObject({
        kind: "function",
        layer: "managed",
        deterministic: true,
        mutatable: true,
      });
    }
    expect(qDc.symbols.find((s) => s.name === "handleDesktopRequest")).toMatchObject({
      kind: "function",
      layer: "managed",
      deterministic: false,
      mutatable: true,
    });
  });

  it("passes all colocated unit and forAll tests identically across js, c, and wasm", async () => {
    const backends: Backend[] = ["js", "c", "wasm"];
    for (const [label, file, all] of [
      ["engine", ENGINE_SZIGYR, true],
      ["desktop-core", DESKTOP_CORE_SZIGYR, false],
    ] as const) {
      const namesByBackend: string[][] = [];
      for (const backend of backends) {
        const r = await runTestFile(file, { backend, all });
        expect(r.diagnostics, `${label} diagnostics for ${backend}`).toEqual([]);
        expect(r.results.length).toBeGreaterThan(0);
        for (const t of r.results) {
          expect(t.ok, `${label} ${backend} ${t.name}: ${t.failure ?? ""}`).toBe(true);
        }
        namesByBackend.push(r.results.map((t) => t.name));
      }
      expect(namesByBackend[1]).toEqual(namesByBackend[0]);
      expect(namesByBackend[2]).toEqual(namesByBackend[0]);
    }
  }, 120_000);

  it("proves all dsp rt obligations strictly and kills 100% non-equivalent mutants", async () => {
    const proveRes = await prove(ENGINE_SZIGYR, { all: true, cache: false });
    expect(proveRes.diagnostics).toEqual([]);
    expect(proveRes.summary.failed).toBe(0);
    expect(proveRes.summary.unknown).toBe(0);
    expect(proveRes.summary.timeout).toBe(0);
    expect(proveRes.summary.proved).toBeGreaterThan(0);

    const mutEngine = await mutateFile(ENGINE_SZIGYR, { all: true, cache: false });
    expect(mutEngine.diagnostics).toEqual([]);
    expect(mutEngine.baselineFailure).toBeNull();
    expect(mutEngine.summary.targets).toBeGreaterThanOrEqual(30);
    expect(mutEngine.summary.killed).toBeGreaterThan(400);
    expect(mutEngine.summary.survived).toBe(0);

    const mutDc = await mutateFile(DESKTOP_CORE_SZIGYR, { cache: false });
    expect(mutDc.diagnostics).toEqual([]);
    expect(mutDc.baselineFailure).toBeNull();
    expect(mutDc.summary.killed).toBeGreaterThan(80);
    expect(mutDc.summary.survived).toBe(0);
  }, 180_000);
});

describe.skipIf(!pw)("examples/microdaw Browser --mode=lib --release + Playwright AudioWorklet E2E", () => {
  for (const coi of [true, false]) {
    it(`plays Wasm AudioWorklet stereo PCM and handles controls (${coi ? "COOP/COEP SAB" : "MessagePort fallback"})`, async () => {
      const analysis = analyze(ENGINE_SZIGYR);
      expect(analysis.diagnostics).toEqual([]);
      const proveRes = await prove(ENGINE_SZIGYR, { analysis, all: true, cache: false });
      expect(proveRes.diagnostics).toEqual([]);
      expect(proveRes.summary.failed).toBe(0);
      expect(proveRes.summary.unknown).toBe(0);

      const outDir = makeTmp(`szigyr-microdaw-web-${coi ? "sab" : "msg"}-`);
      const built = buildBrowser(ENGINE_SZIGYR, {
        outDir,
        mode: "lib",
        analysis,
        proved: proveRes.proved,
      });
      expect(built.diagnostics).toEqual([]);
      expect(built.provedEliminated).toBeGreaterThan(0);
      cpSync(UI_DIR, outDir, { recursive: true });

      const srv = await serveDir(outDir, coi);
      const browser = await pw!.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
      const pageErrors: string[] = [];
      const consoleErrors: string[] = [];
      try {
        const page = await browser.newPage();
        page.on("pageerror", (e: Error) => pageErrors.push(String(e)));
        page.on("console", (msg: { type: () => string; text: () => string }) => {
          if (msg.type() === "error") consoleErrors.push(msg.text());
        });

        await page.addInitScript(() => {
          const w = window as unknown as Record<string, unknown>;
          const chunks: number[][] = [];
          w.__capturedChunks = chunks;
          w.__microdawAudioHook = {
            onNode: async (node: AudioNode, ctx: AudioContext) => {
              await ctx.audioWorklet.addModule("/capture-worklet.js");
              const cap = new AudioWorkletNode(ctx, "capture-worklet", {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                channelCount: 2,
                channelCountMode: "explicit",
                outputChannelCount: [2],
              });
              cap.port.onmessage = (ev) => {
                if (chunks.length < 2500) chunks.push(Array.from(new Float32Array(ev.data as ArrayBuffer)));
              };
              node.connect(cap);
              cap.connect(ctx.destination);
            },
          };
        });

        await page.goto(srv.url, { waitUntil: "load" });
        await page.waitForFunction(
          () => Boolean((window as unknown as { __microdaw?: { isReady?: () => boolean } }).__microdaw?.isReady?.()),
          undefined,
          { timeout: 15_000 },
        );

        const isolated = await page.evaluate(() => self.crossOriginIsolated) as boolean;
        expect(isolated).toBe(coi);
        const badgeText = await page.textContent("#coi-badge");
        expect(badgeText).toContain(coi ? "COI: SAB zero-copy" : "COI: MessagePort fallback");

        await page.click("#btn-play");

        await page.waitForFunction(
          () => {
            const w = window as unknown as {
              __capturedChunks?: number[][];
              __microdaw?: { getTelemetry: () => { step: number; peak: number } };
            };
            const chunks = w.__capturedChunks ?? [];
            let floats = 0;
            let peak = 0;
            for (const c of chunks) {
              floats += c.length;
              for (const s of c) {
                const a = Math.abs(s);
                if (a > peak) peak = a;
              }
            }
            const tel = w.__microdaw?.getTelemetry();
            return floats >= 4096 && peak > 0.05 && Boolean(tel && tel.step >= 1);
          },
          undefined,
          { timeout: 15_000 },
        );

        const audioStats = await page.evaluate(() => {
          const w = window as unknown as { __capturedChunks: number[][] };
          let peak = 0;
          let finite = true;
          let totalFloats = 0;
          for (const c of w.__capturedChunks) {
            totalFloats += c.length;
            for (const s of c) {
              if (!Number.isFinite(s)) finite = false;
              const a = Math.abs(s);
              if (a > peak) peak = a;
            }
          }
          return { peak, finite, totalFloats, chunksCount: w.__capturedChunks.length };
        }) as { peak: number; finite: boolean; totalFloats: number; chunksCount: number };
        expect(audioStats.finite).toBe(true);
        expect(audioStats.peak).toBeGreaterThan(0.05);
        expect(audioStats.totalFloats).toBeGreaterThanOrEqual(4096);

        if (!coi) {
          // Stress MessagePort fallback ring beyond 64 (and 128 cmdTx capacity) to verify tail-advance does not wedge
          const beforeChunks = audioStats.chunksCount;
          await page.evaluate(async () => {
            const w = window as unknown as {
              __microdaw: { session: { setCutoff: (v: number) => void; setStep: (i: number, n: number, v: number) => void } };
            };
            for (let i = 0; i < 140; i += 1) {
              if (i % 2 === 0) w.__microdaw.session.setCutoff(600 + (i % 40) * 180);
              else w.__microdaw.session.setStep(i % 16, 48 + (i % 12), 0.85);
              if (i % 25 === 24) await new Promise((r) => setTimeout(r, 15));
            }
          });
          await page.waitForFunction(
            (minChunks: number) => {
              const w = window as unknown as { __capturedChunks?: number[][] };
              return (w.__capturedChunks?.length ?? 0) > minChunks + 4;
            },
            beforeChunks,
            { timeout: 10_000 },
          );
        }

        await page.click("#step-grid .step-cell");
        await page.click('.wave-btn[data-wave="3"]');
        await page.click('#pad-row .pad-btn[data-note="60"]');
        await page.click("#btn-play");

        const stoppedState = await page.evaluate(async () => {
          const w = window as unknown as {
            __microdaw: { session: { snapshot: () => { wave: number; playing: boolean } }; stopAudio: () => Promise<void> };
          };
          const snap = w.__microdaw.session.snapshot();
          await w.__microdaw.stopAudio();
          return snap;
        }) as { wave: number; playing: boolean };
        expect(stoppedState.wave).toBe(3);
        expect(stoppedState.playing).toBe(false);
        expect(srv.notFound).toEqual([]);
        expect(pageErrors, pageErrors.join("\n")).toEqual([]);
        expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
      } finally {
        await browser.close();
        await srv.close();
      }
    }, 90_000);
  }
});

describe.skipIf(!canWebKit)("examples/microdaw Native Linux WebKitGTK Desktop WebView E2E", () => {
  it("builds relocated C native WebKitGTK app and boots Wasm studio under xvfb-run", async () => {
    expect(check(DESKTOP_SZIGYR)).toEqual([]);

    const desktopDist = makeTmp("szigyr-microdaw-desktop-");
    const builtDesktop = buildNode(DESKTOP_SZIGYR, { outDir: desktopDist, backend: "c" });
    expect(builtDesktop.diagnostics).toEqual([]);
    expect(builtDesktop.files).toContain("program.node");
    expect(builtDesktop.files).toContain("main.js");

    const webDir = join(desktopDist, "web");
    const builtWeb = buildBrowser(ENGINE_SZIGYR, { outDir: webDir, mode: "lib" });
    expect(builtWeb.diagnostics).toEqual([]);
    cpSync(UI_DIR, webDir, { recursive: true });

    const relocated = makeTmp("szigyr-microdaw-desktop-reloc-");
    cpSync(desktopDist, relocated, { recursive: true });

    const { stdout, stderr } = await execFileAsync(
      "xvfb-run",
      ["-a", process.execPath, join(relocated, "main.js"), "--web-dir", join(relocated, "web"), "--smoke-ms", "15000"],
      {
        cwd: relocated,
        env: {
          ...process.env,
          WEBKIT_DISABLE_DMABUF_RENDERER: "1",
          WEBKIT_DISABLE_COMPOSITING_MODE: "1",
        },
        encoding: "utf8",
      },
    );

    const m = stdout.match(/^webview_ready=(.+)$/m);
    expect(m, `missing webview_ready in stdout=${stdout} stderr=${stderr}`).not.toBeNull();
    const payload = JSON.parse(m![1]!) as {
      ok: boolean;
      wasmFinite: boolean;
      wasmPeak: number;
      lastStep: number;
      frames: number;
      error?: string;
    };
    expect(payload, payload.error ?? "").toMatchObject({
      ok: true,
      wasmFinite: true,
      frames: 2048,
    });
    expect(payload.wasmPeak).toBeGreaterThan(0.05);
  }, 120_000);
});

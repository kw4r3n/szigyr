// Stage 5 Milestone 3 tests: browser runtime split, `szigyr build --target=browser`,
// Web Worker Spawn + Wasm, `--mode=lib`, and real Chromium AudioWorklet PCM (440/660/880 Hz).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { buildBrowser } from "../src/index.ts";
import { main as cliMain } from "../src/cli.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".wasm": "application/wasm",
};

function findPlaywright(): { launch: (opts?: Record<string, unknown>) => Promise<any> } | null {
  try {
    const req = createRequire(import.meta.url);
    const pw = (() => {
      try { return req("playwright"); } catch {
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
          if (dir) executablePath = [join(cache, dir, "chrome-linux64/chrome"), join(cache, dir, "chrome-linux/chrome")].find((p) => existsSync(p));
        }
      } else executablePath = def;
    } catch { /* fall back */ }
    if (!executablePath) return null;
    return { launch: (opts) => pw.chromium.launch({ executablePath, ...opts }) };
  } catch {
    return null;
  }
}

const CAPTURE_WORKLET_JS = `
class CaptureWorklet extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    if (inp && inp.length >= 2 && inp[0].length > 0) {
      const n = inp[0].length;
      const inter = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) { inter[i * 2] = inp[0][i]; inter[i * 2 + 1] = inp[1][i]; }
      this.port.postMessage(inter, [inter.buffer]);
      for (let ch = 0; ch < out.length; ch++) if (inp[ch]) out[ch].set(inp[ch]);
    }
    return true;
  }
}
registerProcessor("capture-worklet", CaptureWorklet);
`;

async function serveDir(dir: string, coi: boolean): Promise<{ url: string; close: () => Promise<void> }> {
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
    if (u === "/host.html") {
      res.writeHead(200, { "content-type": MIME[".html"]! });
      res.end("<!doctype html><html><head><meta charset='utf-8'></head><body></body></html>");
      return;
    }
    const rel = u === "/" ? "index.html" : u.replace(/^\/+/, "");
    const abs = resolve(dir, rel);
    if (!abs.startsWith(resolve(dir)) || !existsSync(abs)) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "content-type": MIME[extname(abs)] ?? "application/octet-stream" });
    res.end(readFileSync(abs));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const addr = srv.address() as { port: number };
  return { url: `http://127.0.0.1:${addr.port}`, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

function estimateFreq(left: Float32Array, from: number, to: number, rate = 48000): number {
  let crossings = 0;
  for (let i = from + 1; i < to; i += 1) {
    if ((left[i - 1]! < 0) !== (left[i]! < 0)) crossings += 1;
  }
  return (crossings * rate) / (2 * (to - from));
}

const runCli = async (argv: string[]): Promise<{ code: number; out: string; err: string }> => {
  let out = "", err = "";
  const code = await cliMain(argv, (s) => { out += s; }, (s) => { err += s; });
  return { code, out, err };
};

const portableDemo = join(import.meta.dirname, "../../../examples/audio-portable/main.szigyr");
const ffiDemo = join(import.meta.dirname, "../../../examples/audio/main.szigyr");
const pw = findPlaywright();

describe("browser target builder & CLI", () => {
  it("builds portable audio demo (--mode=app) with zero node: imports or host paths", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "szigyr-bapp-"));
    const r = await runCli(["build", "--target=browser", "-o", outDir, portableDemo]);
    expect(r.code, r.err).toBe(0);
    expect(existsSync(join(outDir, "index.html"))).toBe(true);
    expect(existsSync(join(outDir, "app.js"))).toBe(true);
    expect(existsSync(join(outDir, "program.js"))).toBe(true);
    expect(existsSync(join(outDir, "program.wasm"))).toBe(true);
    expect(existsSync(join(outDir, "szigyr-worker.js"))).toBe(true);
    expect(existsSync(join(outDir, "szigyr-worklet.js"))).toBe(true);

    const checkFiles = ["app.js", "program.js", "szigyr-worker.js", "szigyr-worklet.js", ...readdirSync(join(outDir, "rt")).map((n) => join("rt", n))];
    for (const rel of checkFiles) {
      const txt = readFileSync(join(outDir, rel), "utf8");
      expect(txt, `${rel} node:`).not.toMatch(/["']node:/);
      expect(txt, `${rel} homedir`).not.toContain("/home/");
    }
  });

  it("builds --mode=lib without index.html and without requiring main", async () => {
    const srcDir = mkdtempSync(join(tmpdir(), "szigyr-blib-src-"));
    const outDir = mkdtempSync(join(tmpdir(), "szigyr-blib-out-"));
    const libFile = join(srcDir, "mathlib.szigyr");
    writeFileSync(libFile, `export function saxpy(a: f32, x: Ref<Vec<f32>>, y: Mut<Vec<f32>>): f32 {\n  "use owned";\n  let s: f32 = f32(0);\n  for (let i: usize = 0; i < x.length; i += 1) {\n    y[i] = f32(y[i] + f32(a * x[i]));\n    s = f32(s + y[i]);\n  }\n  return s;\n}\n`);
    const r = await runCli(["build", "--target=browser", "--mode=lib", "-o", outDir, libFile]);
    expect(r.code, r.err).toBe(0);
    expect(existsSync(join(outDir, "index.html"))).toBe(false);
    expect(existsSync(join(outDir, "app.js"))).toBe(true);
    expect(existsSync(join(outDir, "program.wasm"))).toBe(true);
  });

  it("rejects C-only program with E4009 and invalid build flags with exit 2", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "szigyr-bconly-"));
    const r1 = await runCli(["build", "--target=browser", "-o", outDir, ffiDemo]);
    expect(r1.code).toBe(1);
    expect(r1.err).toContain("E4009");
    expect((await runCli(["build", portableDemo])).code).toBe(2);
    expect((await runCli(["build", "--target=unknown", portableDemo])).code).toBe(2);
    expect((await runCli(["build", "--target=browser", "--mode=bad", portableDemo])).code).toBe(2);
    expect((await runCli(["build", "--target=browser", "--backend=wasm", portableDemo])).code).toBe(2);
  });

  it("bundles ESM and CJS npm: dependencies statically without node: imports", async () => {
    const srcDir = mkdtempSync(join(tmpdir(), "szigyr-bnpm-src-"));
    const nm = join(srcDir, "node_modules");
    mkdirSync(join(nm, "esm-pkg"), { recursive: true });
    mkdirSync(join(nm, "cjs-pkg"), { recursive: true });
    writeFileSync(join(nm, "cjs-pkg", "package.json"), JSON.stringify({ name: "cjs-pkg", main: "index.cjs" }));
    writeFileSync(join(nm, "cjs-pkg", "index.cjs"), `exports.mul = (a, b) => a * b;\n`);
    writeFileSync(join(nm, "esm-pkg", "package.json"), JSON.stringify({
      name: "esm-pkg",
      type: "module",
      exports: { ".": { browser: "./browser.mjs", default: "./node.mjs" } },
    }));
    writeFileSync(join(nm, "esm-pkg", "helper.mjs"), `export const bias = 5;\n`);
    writeFileSync(join(nm, "esm-pkg", "ns.mjs"), `export const scale = 2;\n`);
    writeFileSync(join(nm, "esm-pkg", "browser.mjs"), `import { bias } from "./helper.mjs";\nimport { mul } from "cjs-pkg";\nexport * as ns from "./ns.mjs";\nexport * as cns from "cjs-pkg";\nexport function calc(x, y) { return mul(x, y) + bias; }\n`);
    writeFileSync(join(nm, "esm-pkg", "node.mjs"), `export function calc() { return -999; }\n`);

    const entry = join(srcDir, "app.szigyr");
    writeFileSync(entry, [
      `import { calc, ns, cns } from "npm:esm-pkg";`,
      `import { mul } from "npm:cjs-pkg";`,
      `export function main(sys: System): void {`,
      `  const ra = sys.js.call(calc, [sys.js.encode(6), sys.js.encode(7)]);`,
      `  const rb = sys.js.call(mul, [sys.js.encode(3), sys.js.encode(4)]);`,
      `  const s = sys.js.get(ns, "scale");`,
      `  const cmul = sys.js.get(cns, "mul");`,
      `  if (ra.kind === "ok" && rb.kind === "ok" && s.kind === "ok" && cmul.kind === "ok") {`,
      `    const rc = sys.js.call(cmul.value, [s.value, sys.js.encode(5)]);`,
      `    if (rc.kind === "ok") {`,
      `      const a = sys.js.decode<i32>(ra.value);`,
      `      const b = sys.js.decode<i32>(rb.value);`,
      `      const c = sys.js.decode<i32>(rc.value);`,
      `      if (a.kind === "ok" && b.kind === "ok" && c.kind === "ok") sys.log.info(\`\${a.value},\${b.value},\${c.value}\`);`,
      `    }`,
      `  }`,
      `}`,
    ].join("\n"));

    const outDir = mkdtempSync(join(tmpdir(), "szigyr-bnpm-out-"));
    const r = await runCli(["build", "--target=browser", "-o", outDir, entry]);
    expect(r.code, r.err).toBe(0);
    expect(existsSync(join(outDir, "vendor"))).toBe(true);
    for (const rel of readdirSync(join(outDir, "vendor"))) {
      expect(readFileSync(join(outDir, "vendor", rel), "utf8")).not.toMatch(/["']node:/);
    }

    // Copy bundle out to an isolated directory without node_modules and execute app.js as static ESM.
    const isoDir = mkdtempSync(join(tmpdir(), "szigyr-bnpm-iso-"));
    cpSync(outDir, isoDir, { recursive: true });
    let stdout = "";
    const mod = await import(pathToFileURL(join(isoDir, "app.js")).href) as {
      load: () => Promise<{ run: (fn?: unknown, opts?: Record<string, unknown>) => Promise<{ trap: unknown; stdout?: string }> }>;
    };
    const loaded = await mod.load();
    await loaded.run(undefined, { stdout: (s: string) => { stdout += s; } });
    expect(stdout).toBe("47,12,10\n");
  });

  it("fails with exit 2 when an npm: package is missing or imports node:* for browser", async () => {
    const srcDir = mkdtempSync(join(tmpdir(), "szigyr-bnpm-err-"));
    const nm = join(srcDir, "node_modules");
    mkdirSync(join(nm, "node-only-pkg"), { recursive: true });
    writeFileSync(join(nm, "node-only-pkg", "package.json"), JSON.stringify({ name: "node-only-pkg", type: "module", main: "index.mjs" }));
    writeFileSync(join(nm, "node-only-pkg", "index.mjs"), `import fs from "node:fs"; export function r(p) { return fs.readFileSync(p, "utf8"); }\n`);

    const missingEntry = join(srcDir, "missing.szigyr");
    writeFileSync(missingEntry, `import { x } from "npm:definitely-missing-pkg"; export function main(sys: System): void { sys.js.call(x, []); }\n`);
    const r1 = await runCli(["build", "--target=browser", "-o", join(srcDir, "out1"), missingEntry]);
    expect(r1.code).toBe(2);
    expect(r1.err).toContain("definitely-missing-pkg");

    const builtinEntry = join(srcDir, "builtin.szigyr");
    writeFileSync(builtinEntry, `import { r } from "npm:node-only-pkg"; export function main(sys: System): void { sys.js.call(r, []); }\n`);
    const r2 = await runCli(["build", "--target=browser", "-o", join(srcDir, "out2"), builtinEntry]);
    expect(r2.code).toBe(2);
    expect(r2.err).toContain("node:fs");
  });
});

describe.skipIf(!pw)("real Chromium browser verification (Playwright)", () => {
  for (const coi of [true, false]) {
    it(`plays 440 / 660 / 880 Hz via AudioWorklet + Wasm (${coi ? "COOP/COEP SAB" : "MessagePort fallback"})`, async () => {
      const outDir = mkdtempSync(join(tmpdir(), `szigyr-pw-audio-${coi ? "sab" : "msg"}-`));
      const built = buildBrowser(portableDemo, { outDir, mode: "app" });
      expect(built.diagnostics).toEqual([]);
      const srv = await serveDir(outDir, coi);
      const browser = await pw!.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
      try {
        const page = await browser.newPage();
        await page.goto(srv.url);
        const res = await page.evaluate(`(async () => {
          const { start } = await import("./app.js");
          const chunks = [];
          const runRes = await start({
            onNode: async (node, ctx) => {
              await ctx.audioWorklet.addModule("/capture-worklet.js");
              const cap = new AudioWorkletNode(ctx, "capture-worklet", {
                numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: "explicit", outputChannelCount: [2],
              });
              cap.port.onmessage = (ev) => { chunks.push(Array.from(new Float32Array(ev.data))); };
              node.connect(cap);
              cap.connect(ctx.destination);
            },
          });
          let total = 0;
          for (const c of chunks) total += c.length;
          const flat = new Float32Array(total);
          let off = 0;
          for (const c of chunks) { flat.set(c, off); off += c.length; }
          return { isolated: self.crossOriginIsolated, runRes, totalFloats: total, samples: Array.from(flat) };
        })()`) as { isolated: boolean; runRes: { trap: { code: string; line: number } | null }; totalFloats: number; samples: number[] };

        expect(res.isolated).toBe(coi);
        expect(res.runRes.trap).toBeNull();
        const frames = res.samples.length / 2;
        expect(frames).toBeGreaterThan(48000 * 0.5);
        expect(frames).toBeLessThan(48000 * 2.0);
        const left = new Float32Array(frames);
        let peak = 0;
        for (let i = 0; i < frames; i++) {
          const l = res.samples[i * 2]!, r = res.samples[i * 2 + 1]!;
          left[i] = l;
          const a = Math.abs(l);
          if (a > peak) peak = a;
          expect(a).toBeLessThanOrEqual(0.5 + 1e-6);
          expect(Math.abs(r - l)).toBeLessThanOrEqual(1e-6);
        }
        expect(peak).toBeGreaterThan(0.45);
        const third = Math.floor(frames / 3);
        const want = [440, 660, 880];
        for (let k = 0; k < 3; k++) {
          const f = estimateFreq(left, k * third + Math.floor(third * 0.2), k * third + Math.floor(third * 0.8));
          expect(Math.abs(f - want[k]!), `coi=${coi} seg=${k} f=${f}`).toBeLessThan(want[k]! * 0.15);
        }
      } finally {
        await browser.close();
        await srv.close();
      }
    }, 60000);
  }

  it("surfaces AudioWorklet Wasm callback trap (T002) with source position", async () => {
    const srcDir = mkdtempSync(join(tmpdir(), "szigyr-pw-trap-src-"));
    const outDir = mkdtempSync(join(tmpdir(), "szigyr-pw-trap-out-"));
    const entry = join(srcDir, "main.szigyr");
    writeFileSync(entry, [
      `type St = OwnedStruct<{ n: i32 }>;`,
      `function cb(st: Mut<St>, out: Mut<Slice<f32>>, frames: usize): void {`,
      `  "use rt";`,
      `  if (st.n >= 1) {`,
      `    out[frames] = f32(1);`,
      `  }`,
      `  st.n += 1;`,
      `}`,
      `export async function main(sys: System): Promise<void> {`,
      `  const s: St = { n: 0 };`,
      `  const r = await sys.audio.open({ sampleRate: 48000, channels: 1 }, s, cb);`,
      `  if (r.kind === "err") return;`,
      `  await sys.clock.sleep(200);`,
      `  await r.value.close();`,
      `}`,
    ].join("\n"));
    const built = buildBrowser(entry, { outDir, mode: "app" });
    expect(built.diagnostics).toEqual([]);
    const srv = await serveDir(outDir, false);
    const browser = await pw!.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
    try {
      const page = await browser.newPage();
      await page.goto(srv.url);
      const res = await page.evaluate(`(async () => {
        const { start } = await import("./app.js");
        return start();
      })()`) as { trap: { code: string; line: number } | null };
      expect(res.trap).not.toBeNull();
      expect(res.trap!.code).toBe("T002");
      expect(res.trap!.line).toBe(5);
    } finally {
      await browser.close();
      await srv.close();
    }
  }, 60000);

  it("runs Spawn Web Worker isolates (+ Wasm + Ring + Trap) and --mode=lib in Chromium", async () => {
    const srcDir = mkdtempSync(join(tmpdir(), "szigyr-pw-spawn-src-"));
    const outDir = mkdtempSync(join(tmpdir(), "szigyr-pw-spawn-out-"));
    const entry = join(srcDir, "main.szigyr");
    writeFileSync(entry, [
      `function sumVec(v: Ref<Vec<f32>>): f32 {`,
      `  "use owned";`,
      `  let s: f32 = f32(0);`,
      `  for (let i: usize = 0; i < v.length; i += 1) { s = f32(s + v[i]); }`,
      `  return s;`,
      `}`,
      `function oob(): f32 {`,
      `  panic("boom");`,
      `}`,
      `async function workerOk(port: Port<f32, Vec<f32>>, alloc: Alloc): Promise<void> {`,
      `  const v = await port.recv();`,
      `  if (v !== null) {`,
      `    const tmp = Vec.create<f32>(alloc, 1);`,
      `    tmp.push(sumVec(v));`,
      `    port.send(tmp[0]);`,
      `  }`,
      `}`,
      `async function workerTrap(port: Port<i32, i32>): Promise<void> {`,
      `  await port.recv();`,
      `  oob();`,
      `}`,
      `export async function main(sys: System): Promise<void> {`,
      `  const p = sys.spawn.isolate<Vec<f32>, f32>(workerOk);`,
      `  const v = Vec.create<f32>(sys.alloc, 4);`,
      `  v.push(f32(1.5)); v.push(f32(2.5)); v.push(f32(3));`,
      `  p.send(v);`,
      `  const ans = await p.recv();`,
      `  const b = Vec.create<u8>(sys.alloc, 2);`,
      `  const rb = sys.fs.readBytes("x", b);`,
      `  const wb = sys.fs.writeBytes("x", b);`,
      `  const fsCode = rb.kind === "err" && wb.kind === "err" ? \`\${rb.error.code}:\${wb.error.code}\` : "ok";`,
      `  if (ans !== null) sys.log.info(\`sum=\${ans};fs=\${fsCode}\`);`,
      `  p.close();`,
      `}`,
      `export async function testTrap(sys: System): Promise<void> {`,
      `  const p = sys.spawn.isolate<i32, i32>(workerTrap);`,
      `  p.send(1);`,
      `  await p.recv();`,
      `}`,
    ].join("\n"));
    const built = buildBrowser(entry, { outDir, mode: "app" });
    expect(built.diagnostics).toEqual([]);

    const libDir = mkdtempSync(join(tmpdir(), "szigyr-pw-lib-out-"));
    const libEntry = join(srcDir, "lib.szigyr");
    writeFileSync(libEntry, [
      `export function dot(a: Ref<Vec<f32>>, b: Ref<Vec<f32>>): f32 {`,
      `  "use owned";`,
      `  let s: f32 = f32(0);`,
      `  for (let i: usize = 0; i < a.length && i < b.length; i += 1) { s = f32(s + f32(a[i] * b[i])); }`,
      `  return s;`,
      `}`,
    ].join("\n"));
    expect(buildBrowser(libEntry, { outDir: libDir, mode: "lib" }).diagnostics).toEqual([]);

    const srv1 = await serveDir(outDir, true);
    const srv2 = await serveDir(libDir, false);
    const browser = await pw!.launch();
    try {
      const p1 = await browser.newPage();
      await p1.goto(srv1.url);
      const r1 = await p1.evaluate(`(async () => {
        const { load } = await import("./app.js");
        const loaded = await load();
        const okRes = await loaded.run(loaded.exports.main);
        const trapRes = await loaded.run(loaded.exports.testTrap);
        return { okRes, trapRes };
      })()`) as { okRes: { stdout: string; trap: unknown }; trapRes: { trap: { code: string; line: number } | null } };
      expect(r1.okRes.trap).toBeNull();
      expect(r1.okRes.stdout).toBe("sum=7;fs=ENOSYS:ENOSYS\n");
      expect(r1.trapRes.trap).not.toBeNull();
      expect(r1.trapRes.trap!.code).toBe("T006");
      expect(r1.trapRes.trap!.line).toBe(8);

      const p2 = await browser.newPage();
      await p2.goto(`${srv2.url}/host.html`);
      const libVal = await p2.evaluate(`(async () => {
        const { load } = await import("./app.js");
        const { Vec } = await import("./rt/browser.js");
        const { exports, createSystem } = await load();
        const sys = createSystem();
        const a = Vec.create(sys.alloc, 3, "f32");
        const b = Vec.create(sys.alloc, 3, "f32");
        a.push(2); a.push(3); a.push(4);
        b.push(5); b.push(6); b.push(7);
        return exports.dot(a, b);
      })()`) as number;
      expect(libVal).toBeCloseTo(2 * 5 + 3 * 6 + 4 * 7, 5);
    } finally {
      await browser.close();
      await srv1.close();
      await srv2.close();
    }
  }, 60000);
});

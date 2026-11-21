// Browser target builder (`szigyr build --target=browser [--mode=app|lib] [-o <dir>]`, Q285).
// Emits static ES modules (CSP-safe, zero `node:*` imports), compiled `.wasm`, AudioWorklet & Worker adapters.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, cOnlyDiagnostic, checkMain, type Analysis } from "./index.ts";
import { bundleNpmImports, emitNpmPreamble } from "./bundle-npm.ts";
import type { Diagnostic } from "./diagnostics.ts";
import { DETMATH_PATH } from "./detmath.ts";
import { emitFile, EXPORTS, IMP, RT } from "./emit.ts";
import { emitC, type WasmMeta } from "./emit-c.ts";
import { canonPath } from "./modules.ts";
import { CLI_NAME } from "./names.ts";
import type { Parser } from "./parse.ts";
import type { ProvedChecks } from "./prove.ts";
import { compileWasm } from "./wasm.ts";

export type BrowserBuildMode = "app" | "lib";

export interface BrowserBuildOptions {
  outDir: string;
  mode?: BrowserBuildMode;
  analysis?: Analysis;
  parser?: Parser;
  proved?: ProvedChecks;
}

export interface BrowserBuildResult {
  readonly diagnostics: Diagnostic[];
  readonly outDir: string;
  readonly files: string[];
  readonly provedEliminated?: number;
}

const RT_SRC_DIR = fileURLToPath(new URL("../../runtime-js/src/", import.meta.url));
const STD_SRC_DIR = fileURLToPath(new URL("../../std/src/", import.meta.url));

const RT_BROWSER_FILES = [
  "trap.ts", "num.ts", "collections.ts", "result.ts", "test.ts",
  "arbitrary.ts", "wasm-bridge.ts", "port.ts", "isolate-browser.ts", "browser.ts",
] as const;

const STD_BROWSER_FILES: [string, string][] = [
  ["types.ts", "std-types.js"],
  ["fake.ts", "std-fake.js"],
  ["browser.ts", "std-browser.js"],
];

function transpileBrowserModule(tsPath: string, rewrite: (spec: string) => string): string {
  const src = readFileSync(tsPath, "utf8");
  const stripped = stripTypeScriptTypes(src);
  return stripped.replace(/(from\s+)(["'])([^"']+\.ts)\2/g, (_m, kw: string, q: string, spec: string) => `${kw}${q}${rewrite(spec)}${q}`);
}

/** Emits a standalone browser-ready bundle directory (`app` or `lib` mode). */
export function buildBrowser(entryFile: string, opts: BrowserBuildOptions): BrowserBuildResult {
  const outDir = resolve(opts.outDir);
  const mode: BrowserBuildMode = opts.mode ?? "app";
  const a = opts.analysis ?? analyze(entryFile, opts.parser);
  if (a.diagnostics.length) return { diagnostics: a.diagnostics, outDir, files: [] };
  const e4009 = cOnlyDiagnostic(a.files, a.unsafeOps ?? []);
  if (e4009) return { diagnostics: [e4009], outDir, files: [] };
  if (mode === "app") checkMain(a.decls!, entryFile);

  const entry = canonPath(entryFile);
  const entryDir = dirname(entry);
  const keyOf = (absPath: string): string => (absPath === DETMATH_PATH ? "@detmath" : relative(entryDir, absPath).split("\\").join("/"));

  const c = emitC(a.decls!, "wasm", opts.proved ? { proved: opts.proved } : undefined);
  const meta: WasmMeta | null = c?.meta && (Object.keys(c.meta.fns).length > 0 || (c.meta.audio && Object.keys(c.meta.audio).length > 0)) ? c.meta : null;
  const wasmBytes = c && meta ? compileWasm(c.c) : null;

  const rtDir = join(outDir, "rt");
  mkdirSync(rtDir, { recursive: true });
  const written: string[] = [];
  const emitOut = (relPath: string, content: string | Uint8Array): void => {
    const abs = join(outDir, relPath);
    writeFileSync(abs, content);
    written.push(relPath);
  };

  for (const name of RT_BROWSER_FILES) {
    const js = transpileBrowserModule(join(RT_SRC_DIR, name), (s) => s.replace(/\.ts$/, ".js"));
    emitOut(`rt/${name.replace(/\.ts$/, ".js")}`, js);
  }
  for (const [srcName, outName] of STD_BROWSER_FILES) {
    const js = transpileBrowserModule(join(STD_SRC_DIR, srcName), (s) => {
      if (s.includes("runtime-js/src/")) return "./browser.js";
      if (s === "./types.ts") return "./std-types.js";
      if (s === "./fake.ts") return "./std-fake.js";
      return s.replace(/\.ts$/, ".js");
    });
    emitOut(`rt/${outName}`, js);
  }

  if (wasmBytes) emitOut("program.wasm", wasmBytes);

  const modEntries: string[] = [];
  const npmRefs: { fromFile: string; spec: string }[] = [];
  const dispMap = new Map(a.decls!.mods.map((m) => [m.file, keyOf(m.pf.path)]));
  const metaSafe = meta ? { ...meta, files: meta.files.map((f) => dispMap.get(f) ?? f) } : null;
  for (const pf of a.files) {
    const key = keyOf(pf.path);
    const disp = key === "@detmath" ? "@detmath" : key;
    const em = emitFile(pf, disp, false, c?.keys as Map<never, string> | undefined, a.decls!.isolateEntries.get(pf.path), undefined, keyOf);
    for (const spec of em.imports) if (spec.startsWith("npm:")) npmRefs.push({ fromFile: pf.path, spec });
    modEntries.push(`  ${JSON.stringify(key)}: (${RT}, ${IMP}, ${EXPORTS}) => {\n${em.js}\n  }`);
  }
  const npmBundled = bundleNpmImports(npmRefs, outDir, { allowNodeBuiltins: false });
  written.push(...npmBundled.files);
  const npmPreamble = emitNpmPreamble(npmBundled.entries);
  emitOut("program.js", [
    `export const ENTRY = ${JSON.stringify(keyOf(entry))};`,
    `export const WASM_FILE = ${JSON.stringify(wasmBytes ? "./program.wasm" : null)};`,
    `export const WASM_META = ${JSON.stringify(metaSafe)};`,
    `export const MODULES = {\n${modEntries.join(",\n")}\n};`,
    "",
  ].join("\n"));

  emitOut(`${CLI_NAME}-worker.js`, [
    `import * as rt from "./rt/browser.js";`,
    `import * as std from "./rt/std-browser.js";`,
    `import { MODULES, WASM_META } from "./program.js";`,
    ...npmPreamble.header,
    npmPreamble.mapDecl,
    `const queued = [];`,
    `let ready = false;`,
    `self.addEventListener("message", async (ev) => {`,
    `  const d = ev.data;`,
    `  if (!d || typeof d !== "object" || !d.init) { if (!ready) queued.push(d); return; }`,
    `  const { path, name, wasmUrl, wasmBytes, idSab, workerPrefix } = d.init;`,
    `  try {`,
    `    rt.initHostIds(idSab, workerPrefix);`,
    `    let native;`,
    `    if (WASM_META && (wasmBytes || wasmUrl)) {`,
    `      const buf = wasmBytes ?? await (await fetch(wasmUrl)).arrayBuffer();`,
    `      native = await rt.instantiateWasmAsync(buf, WASM_META, rt.NATIVE_HOST);`,
    `    }`,
    `    rt.setBrowserIsolateConfig({ workerUrl: import.meta.url, wasmUrl, wasmBytes });`,
    `    const RUNTIME = { ...rt, FakeAudio: std.FakeAudio, FakeClock: std.FakeClock, SeededRandom: std.SeededRandom, MemoryLog: std.MemoryLog, FakeFs: std.FakeFs, FakeSpawn: std.FakeSpawn, TestAlloc: std.TestAlloc, ...(native ? { native } : {}) };`,
    `    const done = new Map();`,
    `    const instantiate = (k) => {`,
    `      if (k.startsWith("npm:")) {`,
    `        if (Object.hasOwn(BUNDLED_NPM, k)) return BUNDLED_NPM[k];`,
    `        throw new Error("npm module not bundled: " + k);`,
    `      }`,
    `      let ex = done.get(k);`,
    `      if (ex) return ex;`,
    `      ex = {};`,
    `      done.set(k, ex);`,
    `      const fn = MODULES[k];`,
    `      if (!fn) throw new Error("module not found: " + k);`,
    `      return fn(RUNTIME, instantiate, ex);`,
    `    };`,
    `    const mod = instantiate(path);`,
    `    const fn = mod[name];`,
    `    if (typeof fn !== "function") throw new Error("isolate entry not found: " + name);`,
    `    ready = true;`,
    `    rt.isolateMainBrowser(fn, queued);`,
    `  } catch (e) {`,
    `    self.postMessage({ t: { code: "T006", message: String(e) } });`,
    `  }`,
    `});`,
    "",
  ].join("\n"));

  emitOut(`${CLI_NAME}-worklet.js`, WORKLET_JS);

  emitOut("app.js", [
    `import * as rt from "./rt/browser.js";`,
    `import * as std from "./rt/std-browser.js";`,
    `import { ENTRY, MODULES, WASM_FILE, WASM_META } from "./program.js";`,
    ...npmPreamble.header,
    npmPreamble.mapDecl,
    ``,
    `export async function load(options = {}) {`,
    `  const base = new URL(".", import.meta.url);`,
    `  const wasmUrl = options.wasmUrl ?? (WASM_FILE ? new URL(WASM_FILE, base).href : null);`,
    `  const workletUrl = options.workletUrl ?? new URL("./${CLI_NAME}-worklet.js", base).href;`,
    `  const workerUrl = options.workerUrl ?? new URL("./${CLI_NAME}-worker.js", base).href;`,
    `  let wasmBytes = null;`,
    `  let native;`,
    `  if (WASM_META && wasmUrl) {`,
    `    const res = await fetch(wasmUrl);`,
    `    if (!res.ok) throw new Error("Failed to fetch " + wasmUrl + ": " + res.status);`,
    `    wasmBytes = new Uint8Array(await res.arrayBuffer());`,
    `    native = await rt.instantiateWasmAsync(wasmBytes, WASM_META, rt.NATIVE_HOST);`,
    `  }`,
    `  rt.setBrowserIsolateConfig({ workerUrl, wasmUrl, wasmBytes });`,
    `  rt.setForeignTrapCheck(() => {`,
    `    const t = rt.takeIsolateTrap();`,
    `    if (t) rt.trap(t.code, t.message ?? "trap in an isolate or audio callback", t.file ? { file: t.file, line: t.line, col: t.col } : undefined);`,
    `  });`,
    `  const RUNTIME = { ...rt, FakeAudio: std.FakeAudio, FakeClock: std.FakeClock, SeededRandom: std.SeededRandom, MemoryLog: std.MemoryLog, FakeFs: std.FakeFs, FakeSpawn: std.FakeSpawn, TestAlloc: std.TestAlloc, ...(native ? { native } : {}) };`,
    `  const npmMap = { ...BUNDLED_NPM, ...(options.npm ?? {}) };`,
    `  const done = new Map();`,
    `  const instantiate = (k) => {`,
    `    if (k.startsWith("npm:")) {`,
    `      if (Object.hasOwn(npmMap, k)) return npmMap[k];`,
    `      throw new Error("npm module not bundled: " + k);`,
    `    }`,
    `    let ex = done.get(k);`,
    `    if (ex) return ex;`,
    `    ex = {};`,
    `    done.set(k, ex);`,
    `    const fn = MODULES[k];`,
    `    if (!fn) throw new Error("module not found: " + k);`,
    `    return fn(RUNTIME, instantiate, ex);`,
    `  };`,
    `  const exports = instantiate(ENTRY);`,
    `  const createSystem = (sysOpts = {}) => std.createBrowserSystem({ workletUrl, wasmBytes, wasmMeta: WASM_META, ...sysOpts });`,
    `  const run = (mainFn = exports.main, sysOpts = {}) => std.runMainBrowser(mainFn, { workletUrl, wasmBytes, wasmMeta: WASM_META, ...sysOpts });`,
    `  const stop = () => { rt.stopFakeIsolates(); return Promise.all([rt.stopIsolates(), std.stopBrowserAudioStreams()]); };`,
    `  return { exports, native, wasmBytes, Vec: rt.Vec, createSystem, run, stop };`,
    `}`,
    ...(mode === "app" ? [
      `export async function start(options = {}) {`,
      `  const loaded = await load(options);`,
      `  return loaded.run(loaded.exports.main, options);`,
      `}`,
    ] : []),
    "",
  ].join("\n"));

  if (mode === "app") emitOut("index.html", INDEX_HTML);
  return { diagnostics: [], outDir, files: written, ...(opts.proved ? { provedEliminated: c?.eliminated ?? 0 } : {}) };
}

const WORKLET_JS = [
  `import * as rt from "./rt/browser.js";`,
  `class SzigyrAudioProcessor extends AudioWorkletProcessor {`,
  `  constructor(options) {`,
  `    super();`,
  `    const po = options.processorOptions ?? {};`,
  `    this.channels = po.channels ?? 2;`,
  `    this.cbId = po.cbId ?? 0;`,
  `    this.ready = false;`,
  `    this.closed = false;`,
  `    this.trapped = false;`,
  `    this.audioMod = null;`,
  `    this.boxPtr = 0;`,
  `    this.interleaved = new Float32Array(128 * this.channels);`,
  `    this.rings = new Map();`,
  `    this.pending = [];`,
  `    this.port.onmessage = (ev) => {`,
  `      const m = ev.data;`,
  `      if (!m || typeof m !== "object") return;`,
  `      if (m.k === "close") {`,
  `        this.closed = true;`,
  `        if (this.audioMod && this.boxPtr) { try { this.audioMod.free(this.boxPtr); } catch {} this.boxPtr = 0; }`,
  `        return;`,
  `      }`,
  `      if (m.k === "r") {`,
  `        if (!this.ready) { this.pending.push(m); return; }`,
  `        const sh = this.rings.get(m.i);`,
  `        if (sh) rt.ringPushRaw(sh, new Uint8Array(m.b));`,
  `      }`,
  `    };`,
  `    this.initWasm(po);`,
  `  }`,
  `  async initWasm(po) {`,
  `    try {`,
  `      const api = await rt.instantiateWasmAsync(po.wasmBytes, po.wasmMeta, rt.NATIVE_HOST);`,
  `      this.audioMod = api["sz_audio_" + this.cbId];`,
  `      if (!this.audioMod) throw new Error("missing sz_audio_" + this.cbId);`,
  `      const memo = new Map();`,
  `      const unpack = (v) => {`,
  `        if (v !== null && typeof v === "object") {`,
  `          if ("$szVec" in v) return rt.Vec.unpack(v.$szVec);`,
  `          if ("$szPool" in v) return rt.Pool.unpack(v.$szPool);`,
  `          if ("$szArena" in v) return rt.Arena.unpack(v.$szArena);`,
  `        }`,
  `        if (v !== null && typeof v === "object" && "$szRing" in v) {`,
  `          const spec = v.$szRing;`,
  `          let sh = memo.get(spec);`,
  `          if (!sh) {`,
  `            const end = spec.atomic`,
  `              ? rt.Ring.fromShared(spec.sab, spec.cap, spec.elem)`,
  `              : rt.Ring.fromShared(spec.buf ?? new ArrayBuffer(8 + spec.cap * 8), spec.cap, spec.elem);`,
  `            sh = end.tx.shared;`,
  `            if (!spec.atomic && spec.id) {`,
  `              this.rings.set(spec.id, sh);`,
  `              sh.onPush = (bytes) => { try { this.port.postMessage({ k: "r", i: spec.id, b: bytes }, [bytes.buffer]); } catch {} };`,
  `            }`,
  `            memo.set(spec, sh);`,
  `          }`,
  `          return v.tx ? new rt.RingTx(sh) : new rt.RingRx(sh);`,
  `        }`,
  `        if (v !== null && typeof v === "object") {`,
  `          if (Array.isArray(v)) return v.map(unpack);`,
  `          const out = {};`,
  `          for (const [k, x] of Object.entries(v)) out[k] = unpack(x);`,
  `          return out;`,
  `        }`,
  `        return v;`,
  `      };`,
  `      const st = unpack(po.stateWire);`,
  `      for (const m of this.pending.splice(0)) {`,
  `        const sh = this.rings.get(m.i);`,
  `        if (sh) rt.ringPushRaw(sh, new Uint8Array(m.b));`,
  `      }`,
  `      this.boxPtr = this.audioMod.init(st);`,
  `      this.ready = true;`,
  `      this.port.postMessage({ k: "ready" });`,
  `    } catch (e) {`,
  `      this.closed = true;`,
  `      this.port.postMessage({ k: "error", message: String(e) });`,
  `    }`,
  `  }`,
  `  process(_inputs, outputs) {`,
  `    const out = outputs[0];`,
  `    if (!out || !out.length) return !this.closed;`,
  `    const frames = out[0].length;`,
  `    if (!this.ready || this.closed || this.trapped) {`,
  `      for (let ch = 0; ch < out.length; ch++) out[ch].fill(0);`,
  `      return !this.closed;`,
  `    }`,
  `    const need = frames * this.channels;`,
  `    if (this.interleaved.length < need) this.interleaved = new Float32Array(need);`,
  `    const buf = this.interleaved.length === need ? this.interleaved : this.interleaved.subarray(0, need);`,
  `    buf.fill(0);`,
  `    try {`,
  `      this.audioMod.render(this.boxPtr, buf, frames);`,
  `    } catch (ex) {`,
  `      this.trapped = true;`,
  `      buf.fill(0);`,
  `      const t = rt.asTrap(ex);`,
  `      this.port.postMessage({ k: "trap", code: t ? t.code : "T006", ...(t?.pos ? { file: t.pos.file, line: t.pos.line, col: t.pos.col } : {}) });`,
  `    }`,
  `    for (let ch = 0; ch < out.length; ch++) {`,
  `      const dst = out[ch];`,
  `      if (ch < this.channels) { for (let i = 0; i < frames; i++) dst[i] = buf[i * this.channels + ch]; }`,
  `      else dst.fill(0);`,
  `    }`,
  `    return !this.closed;`,
  `  }`,
  `}`,
  `registerProcessor("szigyr-audio-processor", SzigyrAudioProcessor);`,
  "",
].join("\n");

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Szigyr Browser App</title>
  <style>body{font-family:system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem}pre{background:#f4f4f6;padding:1rem;border-radius:6px;white-space:pre-wrap}.warn{color:#9a6700;font-size:.9rem}</style>
</head>
<body>
  <h1>Szigyr Browser App</h1>
  <p id="coi" class="warn"></p>
  <button id="start" type="button">Start</button>
  <pre id="out"></pre>
  <script type="module">
    import { start } from "./app.js";
    const coi = document.getElementById("coi");
    coi.textContent = self.crossOriginIsolated
      ? "crossOriginIsolated: enabled (SharedArrayBuffer zero-copy rings)"
      : "crossOriginIsolated: disabled (using MessagePort ring fallback)";
    const out = document.getElementById("out");
    document.getElementById("start").addEventListener("click", async () => {
      out.textContent = "Running...\\n";
      try {
        const res = await start({
          stdout: (s) => { out.textContent += s; },
          stderr: (s) => { out.textContent += s; },
        });
        if (res.trap) out.textContent += "\\ntrap " + res.trap.code + " at " + res.trap.file + ":" + res.trap.line + ":" + res.trap.col + "\\n";
        else out.textContent += "\\nDone.\\n";
      } catch (e) {
        out.textContent += "\\nError: " + String(e) + "\\n";
      }
    });
  </script>
</body>
</html>
`;

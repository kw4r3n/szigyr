// Node target builder (`szigyr build --target=node [--mode=app|lib] [--backend=c|js|wasm] [-o <dir>]`).
// Emits standalone ESM + rt/std runtime + native C `.node` addon (default) or `.wasm` + bundled `vendor/`.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleNpmImports, emitNpmPreamble } from "./bundle-npm.ts";
import { DETMATH_PATH } from "./detmath.ts";
import { DISPLAY_SDL_C } from "./display-sdl.ts";
import type { Diagnostic } from "./diagnostics.ts";
import { emitFile, EXPORTS, IMP, RT, SOURCE_URL } from "./emit.ts";
import { emitC, type WasmMeta } from "./emit-c.ts";
import { analyze, cOnlyDiagnostic, checkMain, type Analysis } from "./index.ts";
import { canonPath } from "./modules.ts";
import { compileNativeAddon } from "./native.ts";
import type { Parser } from "./parse.ts";
import type { ProvedChecks } from "./prove.ts";
import { compileWasm } from "./wasm.ts";

export type NodeBuildMode = "app" | "lib";
export type NodeBuildBackend = "c" | "js" | "wasm";

export interface NodeBuildOptions {
  outDir: string;
  mode?: NodeBuildMode;
  backend?: NodeBuildBackend;
  analysis?: Analysis;
  parser?: Parser;
  proved?: ProvedChecks;
}

export interface NodeBuildResult {
  readonly diagnostics: Diagnostic[];
  readonly outDir: string;
  readonly files: string[];
  readonly provedEliminated?: number;
}

const RT_SRC_DIR = fileURLToPath(new URL("../../runtime-js/src/", import.meta.url));
const STD_SRC_DIR = fileURLToPath(new URL("../../std/src/", import.meta.url));

const RT_NODE_FILES = [
  "trap.ts", "num.ts", "collections.ts", "result.ts", "test.ts",
  "port.ts", "isolate.ts", "arbitrary.ts", "wasm-bridge.ts", "index.ts",
] as const;

const STD_NODE_FILES: [string, string][] = [
  ["types.ts", "std-types.js"],
  ["node.ts", "std-node.js"],
  ["fake.ts", "std-fake.js"],
  ["host.ts", "std-host.js"],
  ["index.ts", "std-index.js"],
];

function transpileNodeModule(tsPath: string, rewrite: (spec: string) => string): string {
  const src = readFileSync(tsPath, "utf8");
  return stripTypeScriptTypes(src).replace(/(from\s+)(["'])([^"']+\.ts)\2/g, (_m, kw: string, q: string, spec: string) => `${kw}${q}${rewrite(spec)}${q}`);
}

/** Emits a standalone Node-ready bundle directory (`app` or `lib` mode; `c`, `js`, or `wasm` backend). */
export function buildNode(entryFile: string, opts: NodeBuildOptions): NodeBuildResult {
  const outDir = resolve(opts.outDir);
  const mode: NodeBuildMode = opts.mode ?? "app";
  const backend: NodeBuildBackend = opts.backend ?? "c";
  const a = opts.analysis ?? analyze(entryFile, opts.parser);
  if (a.diagnostics.length) return { diagnostics: a.diagnostics, outDir, files: [] };
  if (backend !== "c") {
    const e4009 = cOnlyDiagnostic(a.files, a.unsafeOps ?? []);
    if (e4009) return { diagnostics: [e4009], outDir, files: [] };
  }
  if (mode === "app") checkMain(a.decls!, entryFile);

  const entry = canonPath(entryFile);
  const entryDir = dirname(entry);
  const keyOf = (absPath: string): string => (absPath === DETMATH_PATH ? "@detmath" : relative(entryDir, absPath).split("\\").join("/"));

  const rtDir = join(outDir, "rt");
  mkdirSync(rtDir, { recursive: true });
  const written: string[] = [];
  const emitOut = (relPath: string, content: string | Uint8Array): void => {
    const abs = join(outDir, relPath);
    writeFileSync(abs, content);
    written.push(relPath);
  };

  let c: ReturnType<typeof emitC> | undefined;
  let hasNative = false;
  let wasmMeta: WasmMeta | null = null;
  let hasWasm = false;
  const cOpts = opts.proved ? { proved: opts.proved } : undefined;
  if (backend === "c") {
    c = emitC(a.decls!, "native", cOpts);
    if (c) {
      compileNativeAddon(c.c, join(outDir, "program.node"), c.pkgs);
      written.push("program.node");
      hasNative = true;
    }
  } else if (backend === "wasm") {
    c = emitC(a.decls!, "wasm", cOpts);
    const meta = c?.meta && (Object.keys(c.meta.fns).length > 0 || (c.meta.audio && Object.keys(c.meta.audio).length > 0)) ? c.meta : null;
    if (c && meta) {
      const dispMap = new Map(a.decls!.mods.map((m) => [m.file, keyOf(m.pf.path)]));
      wasmMeta = { ...meta, files: meta.files.map((f) => dispMap.get(f) ?? f) };
      emitOut("program.wasm", compileWasm(c.c));
      hasWasm = true;
    }
  }
  let hasDisplay = false;
  if (a.files.some((f) => /\b(display|Display)\b/.test(f.sourceFile.text))) {
    try {
      compileNativeAddon(DISPLAY_SDL_C, join(outDir, "display.node"), []);
      written.push("display.node");
      hasDisplay = true;
    } catch (e) {
      if (backend === "c") throw e;
    }
  }

  for (const name of RT_NODE_FILES) {
    emitOut(`rt/${name.replace(/\.ts$/, ".js")}`, transpileNodeModule(join(RT_SRC_DIR, name), (s) => s.replace(/\.ts$/, ".js")));
  }
  for (const [srcName, outName] of STD_NODE_FILES) {
    const js = transpileNodeModule(join(STD_SRC_DIR, srcName), (s) => {
      if (s.includes("runtime-js/src/")) return "./index.js";
      if (s === "./types.ts") return "./std-types.js";
      if (s === "./node.ts") return "./std-node.js";
      if (s === "./fake.ts") return "./std-fake.js";
      if (s === "./host.ts") return "./std-host.js";
      if (s === "./index.ts") return "./std-index.js";
      return s.replace(/\.ts$/, ".js");
    });
    emitOut(`rt/${outName}`, js);
  }

  const fileEntries: [string, { js: string; imports: string[]; calls: [string, unknown][] }][] = [];
  const npmRefs: { fromFile: string; spec: string }[] = [];
  for (const pf of a.files) {
    const key = keyOf(pf.path);
    const em = emitFile(pf, key, false, c?.keys as Map<never, string> | undefined, a.decls!.isolateEntries.get(pf.path), undefined, keyOf);
    for (const spec of em.imports) if (spec.startsWith("npm:")) npmRefs.push({ fromFile: pf.path, spec });
    fileEntries.push([key, { js: em.js, imports: em.imports, calls: [...em.calls] }]);
  }

  const npmBundled = bundleNpmImports(npmRefs, outDir, { allowNodeBuiltins: true });
  written.push(...npmBundled.files);
  const npmPreamble = emitNpmPreamble(npmBundled.entries);
  const npmUrlExprs = [...npmBundled.entries.entries()]
    .map(([spec, rel]) => `${JSON.stringify(spec)}: ${rel.startsWith("node:") ? JSON.stringify(rel) : `new URL(${JSON.stringify(rel)}, base).href`}`)
    .join(", ");

  emitOut("package.json", `{ "type": "module" }\n`);

  const framePattern = `${SOURCE_URL}(.+?):(\\d+):(\\d+)\\)?$`;
  emitOut("program.js", [
    `export const ENTRY = ${JSON.stringify(keyOf(entry))};`,
    `export const BACKEND = ${JSON.stringify(backend)};`,
    `export const NATIVE_FILE = ${JSON.stringify(hasNative ? "./program.node" : null)};`,
    `export const WASM_FILE = ${JSON.stringify(hasWasm ? "./program.wasm" : null)};`,
    `export const DISPLAY_FILE = ${JSON.stringify(hasDisplay ? "./display.node" : null)};`,
    `export const WASM_META = ${JSON.stringify(wasmMeta)};`,
    `export const RT_NAME = ${JSON.stringify(RT)};`,
    `export const IMP_NAME = ${JSON.stringify(IMP)};`,
    `export const EXPORTS_NAME = ${JSON.stringify(EXPORTS)};`,
    `export const FRAME_PATTERN = ${JSON.stringify(framePattern)};`,
    `export const FILES = ${JSON.stringify(fileEntries)};`,
    "",
  ].join("\n"));

  emitOut("app.js", [
    `import { readFileSync } from "node:fs";`,
    `import { fileURLToPath } from "node:url";`,
    `import * as rt from "./rt/index.js";`,
    `import * as std from "./rt/std-index.js";`,
    `import { ENTRY, NATIVE_FILE, WASM_FILE, DISPLAY_FILE, WASM_META, RT_NAME, IMP_NAME, EXPORTS_NAME, FRAME_PATTERN, FILES } from "./program.js";`,
    ...npmPreamble.header,
    npmPreamble.mapDecl,
    ``,
    `export async function load(options = {}) {`,
    `  const base = new URL(".", import.meta.url);`,
    `  rt.takeIsolateTrap();`,
    `  const NPM_URLS = { ${npmUrlExprs} };`,
    `  let native;`,
    `  let nativePath = null;`,
    `  let nativeProg = null;`,
    `  let wasmBytes = null;`,
    `  if (NATIVE_FILE) {`,
    `    const nativeUrl = options.nativeUrl ?? new URL(NATIVE_FILE, base).href;`,
    `    nativePath = nativeUrl.startsWith("file:") ? fileURLToPath(nativeUrl) : nativeUrl;`,
    `    const m = { exports: {} };`,
    `    process.dlopen(m, nativePath);`,
    `    native = m.exports;`,
    `    nativeProg = native.init(rt.NATIVE_HOST);`,
    `  } else if (WASM_META && WASM_FILE) {`,
    `    const wasmUrl = options.wasmUrl ?? new URL(WASM_FILE, base).href;`,
    `    wasmBytes = new Uint8Array(readFileSync(wasmUrl.startsWith("file:") ? fileURLToPath(wasmUrl) : wasmUrl));`,
    `    native = await rt.instantiateWasmAsync(wasmBytes, WASM_META, rt.NATIVE_HOST);`,
    `  }`,
    `  const activeAudioClosers = new Set();`,
    `  std.setNodeAudio({`,
    `    async open(config, state, cb) {`,
    `      if (!Number.isInteger(config.sampleRate) || config.sampleRate <= 0 || config.sampleRate > 0x7fffffff || !Number.isInteger(config.channels) || config.channels < 1 || config.channels > 32) {`,
    `        return rt.err({ code: "EINVAL", message: "invalid audio config" });`,
    `      }`,
    `      const cOpen = cb.native && cb.native["sz_audio_open_" + cb.id];`,
    `      const cClose = cb.native && cb.native["sz_audio_close_" + cb.id];`,
    `      if (cOpen && cClose) {`,
    `        const res = cOpen(config.sampleRate, config.channels, state);`,
    `        if (res && typeof res === "object" && "error" in res) return rt.err({ code: res.code, message: res.error });`,
    `        let closed = false;`,
    `        const close = async () => { if (closed) return; closed = true; activeAudioClosers.delete(close); cClose(res); };`,
    `        activeAudioClosers.add(close);`,
    `        return rt.ok({ sampleRate: config.sampleRate, channels: config.channels, close, disposeAsync: close, isOpen: () => !closed });`,
    `      }`,
    `      // shortcut: JS/Wasm audio push pump is not bundled in standalone build --target=node; upgrade by bundling an SDL push addon if needed.`,
    `      return rt.err({ code: "ENOSYS", message: "audio push pump is only bundled for --backend=c on Node" });`,
    `    },`,
    `  });`,
    `  if (DISPLAY_FILE) {`,
    `    let displayMod;`,
    `    std.setNodeDisplay(std.createSdlDisplay(() => {`,
    `      if (displayMod) return displayMod;`,
    `      const displayPath = fileURLToPath(new URL(DISPLAY_FILE, base));`,
    `      const m = { exports: {} };`,
    `      process.dlopen(m, displayPath);`,
    `      displayMod = m.exports;`,
    `      return displayMod;`,
    `    }));`,
    `  }`,
    `  const filesMap = new Map(FILES.map(([k, e]) => [k, { js: e.js, imports: e.imports, calls: new Map(e.calls) }]));`,
    `  const frame = new RegExp(FRAME_PATTERN, "gm");`,
    `  rt.setStackLocator((e) => {`,
    `    for (const m of (e.stack ?? "").matchAll(frame)) {`,
    `      const p = filesMap.get(m[1])?.calls.get(m[2] + ":" + m[3]);`,
    `      if (p) return p;`,
    `    }`,
    `    return undefined;`,
    `  });`,
    `  let isolateCause;`,
    `  rt.setForeignTrapCheck(() => {`,
    `    if (native && native.sz_poll) {`,
    `      const v = native.sz_poll();`,
    `      if (Array.isArray(v)) rt.trap("T" + String(v[0]).padStart(3, "0"), "trap in C", v[1] ? { file: v[1], line: v[2], col: v[3] } : undefined);`,
    `    }`,
    `    const t = rt.takeIsolateTrap();`,
    `    if (t) {`,
    `      isolateCause = t.message;`,
    `      rt.trap(t.code, t.message ?? "trap in an isolate", t.file ? { file: t.file, line: t.line, col: t.col } : undefined);`,
    `    }`,
    `  });`,
    `  rt.setIsolateProgram({`,
    `    files: FILES,`,
    `    runtimeUrl: new URL("./rt/index.js", base).href,`,
    `    stdUrl: new URL("./rt/std-index.js", base).href,`,
    `    nativePath,`,
    `    nativeProg,`,
    `    wasmBytes,`,
    `    wasmMeta: WASM_META,`,
    `    npmUrls: NPM_URLS,`,
    `    rtName: RT_NAME,`,
    `    impName: IMP_NAME,`,
    `    exportsName: EXPORTS_NAME,`,
    `    framePattern: FRAME_PATTERN,`,
    `  });`,
    `  const RUNTIME = { ...rt, FakeAudio: std.FakeAudio, FakeClock: std.FakeClock, FakeDisplay: std.FakeDisplay, FakeNet: std.FakeNet, FakeProc: std.FakeProc, SeededRandom: std.SeededRandom, MemoryLog: std.MemoryLog, FakeFs: std.FakeFs, FakeSpawn: std.FakeSpawn, TestAlloc: std.TestAlloc, ...(native ? { native } : {}) };`,
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
    `    const entryMod = filesMap.get(k);`,
    `    if (!entryMod) throw new Error("module not found: " + k);`,
    `    const f = new Function(RT_NAME, IMP_NAME, EXPORTS_NAME, entryMod.js);`,
    `    f(RUNTIME, instantiate, ex);`,
    `    return ex;`,
    `  };`,
    `  const exports = instantiate(ENTRY);`,
    `  const stop = async () => {`,
    `    rt.stopFakeIsolates();`,
    `    std.stopNodeProcs();`,
    `    await Promise.all([rt.stopIsolates(), std.stopNodeDisplays(), std.stopNodeNetServers(), ...[...activeAudioClosers].map((fn) => fn())]);`,
    `  };`,
    `  const createSystem = (stdout, stderr, sysOpts) => std.createSystem(stdout, stderr, sysOpts);`,
    `  const run = async (mainFn = exports.main, sysOpts = {}) => {`,
    `    let stdout = "", stderr = "", v;`,
    `    const outSink = (s) => { stdout += s; if (sysOpts.stdout) sysOpts.stdout(s); };`,
    `    const errSink = (s) => { stderr += s; if (sysOpts.stderr) sysOpts.stderr(s); };`,
    `    const sys = createSystem(outSink, errSink, sysOpts.args ? { args: sysOpts.args } : undefined);`,
    `    const finish = () => { v ??= native?.sz_finish ? native.sz_finish() : null; };`,
    `    let own = null;`,
    `    try {`,
    `      const rejected = await rt.capturing(() => {`,
    `        let p;`,
    `        try { p = mainFn(sys); } catch (e) { finish(); throw e; }`,
    `        if (p instanceof Promise) return p.finally(finish);`,
    `        finish();`,
    `        return p;`,
    `      });`,
    `      if (rejected.length) throw rejected[0];`,
    `    } catch (e) {`,
    `      const t = rt.asTrap(e);`,
    `      if (!t) { await stop(); throw e; }`,
    `      own = { code: t.code, file: t.pos?.file ?? "", line: t.pos?.line ?? 0, col: t.pos?.col ?? 0, ...(isolateCause && t.message === t.code + ": " + isolateCause ? { message: isolateCause } : { message: t.message }) };`,
    `    }`,
    `    await stop();`,
    `    const isoRaw = rt.takeIsolateTrap();`,
    `    const cTrap = Array.isArray(v) ? { code: "T" + String(v[0]).padStart(3, "0"), file: v[1] ?? "", line: v[2] ?? 0, col: v[3] ?? 0, message: "trap in C" } : null;`,
    `    const iso = isoRaw ? { code: isoRaw.code, file: isoRaw.file ?? "", line: isoRaw.line ?? 0, col: isoRaw.col ?? 0, ...(isoRaw.message ? { message: isoRaw.message } : {}) } : null;`,
    `    const trap = own ? (cTrap ?? own) : (iso ?? cTrap);`,
    `    const exitCode = trap ? 3 : std.getProcExitCode(sys.proc);`,
    `    return { stdout, stderr, trap, exitCode };`,
    `  };`,
    `  return { exports, native, Vec: rt.Vec, createSystem, run, stop };`,
    `}`,
    ...(mode === "app" ? [
      `export async function start(options = {}) {`,
      `  const loaded = await load(options);`,
      `  return loaded.run(loaded.exports.main, {`,
      `    stdout: (s) => void process.stdout.write(s),`,
      `    stderr: (s) => void process.stderr.write(s),`,
      `    ...options,`,
      `  });`,
      `}`,
    ] : []),
    "",
  ].join("\n"));

  if (mode === "app") {
    emitOut("main.js", [
      `#!/usr/bin/env node`,
      `import { start } from "./app.js";`,
      `const res = await start();`,
      `if (res.trap) {`,
      `  const p = res.trap.file ? \` at \${res.trap.file}:\${res.trap.line}:\${res.trap.col}\` : "";`,
      `  const msg = res.trap.message ?? "";`,
      `  const head = msg.startsWith(res.trap.code) ? \`trap \${msg}\` : msg ? \`trap \${res.trap.code}: \${msg}\` : \`trap \${res.trap.code}\`;`,
      `  process.stderr.write(\`\${head}\${p}\\n\`);`,
      `  process.exitCode = 3;`,
      `} else if (res.exitCode) {`,
      `  process.exitCode = res.exitCode;`,
      `}`,
      "",
    ].join("\n"));
    chmodSync(join(outDir, "main.js"), 0o755);
  }

  return { diagnostics: [], outDir, files: written, ...(opts.proved ? { provedEliminated: c?.eliminated ?? 0 } : {}) };
}

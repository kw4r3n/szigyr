// §15.2 Node Worker isolate host (imports platform-neutral Port/Channel from ./port.ts).
import { Worker, parentPort } from "node:worker_threads";
import { getHostIdSab } from "./collections.ts";
import { asTrap, noteIsolateTrap, type ForeignTrap } from "./trap.ts";
import { getIsolateProgram, Port, setIsolateProgram, type Channel, type Envelope, type IsolateProgram } from "./port.ts";

export { Port, setIsolateProgram, type IsolateProgram };

const liveWorkers = new Set<Worker>();
let nextWorkerPrefix = 1;
/** §15.2: starts an isolate running the entry function `name` of the module at `path`; returns its port without waiting. */
export function spawnIsolate(path: string, name: string): Port {
  const prog = getIsolateProgram();
  if (!prog) throw new Error("spawnIsolate: no isolate program is installed");
  const w = new Worker(BOOTSTRAP, { eval: true, workerData: { ...prog, path, name, idSab: getHostIdSab(), workerPrefix: nextWorkerPrefix++ } });
  liveWorkers.add(w);
  let gone: (() => void) | undefined;
  const ch: Channel = {
    post: (msg, transfer) => { w.postMessage(msg, transfer as never); },
    onMessage: (f) => { w.on("message", f); },
    onClose: (f) => { gone = f; },
    close: () => { /* the isolate runs until its entry returns; main ending terminates it (stopIsolates) */ },
  };
  w.on("exit", () => { liveWorkers.delete(w); gone?.(); });
  w.on("error", (e) => { noteIsolateTrap({ code: "T006", message: String(e) }); gone?.(); });
  return new Port(ch);
}

/** Q207: when main ends, isolates still running are stopped and undelivered messages discarded. */
export async function stopIsolates(): Promise<void> {
  // A trap the isolate sent just before main ended still counts (§15.4 (3)): let posted messages land.
  await new Promise<void>((r) => setImmediate(r));
  const ws = [...liveWorkers];
  liveWorkers.clear();
  await Promise.all(ws.map((w) => w.terminate()));
}

/** Runs inside the isolate: builds the port over parentPort, calls the entry, and reports a trap
 * before closing the port (§15.4: the isolate stops there, the trap travels to the managed side). */
export function isolateMain(f: (port: Port, alloc: { readonly kind: "alloc" }) => unknown): void {
  const pp = parentPort!;
  const ch: Channel = {
    post: (msg, transfer) => { pp.postMessage(msg, transfer as never); },
    onMessage: (g) => { pp.on("message", g); },
    onClose: () => { /* parentPort has no close event; the main side ending terminates the worker */ },
    close: () => { pp.close(); },
  };
  const port = new Port(ch);
  void (async () => {
    try {
      await f(port, { kind: "alloc" });
    } catch (e) {
      const t = asTrap(e);
      const ft: ForeignTrap = t ? { code: t.code, ...(t.pos ? { file: t.pos.file, line: t.pos.line, col: t.pos.col } : {}) } : { code: "T006", message: String(e) };
      try { pp.postMessage({ t: ft }); } catch { /* the main side is gone */ }
    }
    port.close();
  })();
}

/** The isolate-side bootstrap: mirrors the compiler loader (module factories, the C addon, the
 * §15.4 poll) with this thread's own runtime, then runs the entry through isolateMain. */
const BOOTSTRAP = `
const { parentPort, workerData } = require("node:worker_threads");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");
(async () => {
  const rt = await import(workerData.runtimeUrl);
  rt.initHostIds(workerData.idSab, workerData.workerPrefix);
  const std = await import(workerData.stdUrl);
  let native;
  if (workerData.wasmBytes && workerData.wasmMeta) {
    native = await rt.instantiateWasmAsync(workerData.wasmBytes, workerData.wasmMeta, rt.NATIVE_HOST);
  } else if (workerData.nativePath) {
    const m = { exports: {} };
    process.dlopen(m, workerData.nativePath);
    native = m.exports;
    // D146, D165: init(host, prog) binds this thread's host and joins main's end flag and trap record without resetting them.
    native.init(rt.NATIVE_HOST, workerData.nativeProg);
    rt.setForeignTrapCheck(() => {
      const v = native.sz_poll();
      if (Array.isArray(v)) rt.trap("T" + String(v[0]).padStart(3, "0"), "trap in C", v[1] ? { file: v[1], line: v[2], col: v[3] } : undefined);
    });
  }
  const files = new Map(workerData.files.map(([path, e]) => [path, { js: e.js, imports: e.imports, calls: new Map(e.calls) }]));
  const frame = new RegExp(workerData.framePattern, "gm");
  rt.setStackLocator((e) => {
    for (const m of (e.stack ?? "").matchAll(frame)) {
      const p = files.get(m[1])?.calls.get(m[2] + ":" + m[3]);
      if (p) return p;
    }
    return undefined;
  });
  const unwrapNpm = (mod) => {
    if (!mod || typeof mod !== "object") return mod;
    if (mod.__szCjs) return mod.default;
    const def = mod.default;
    if (def !== null && (typeof def === "object" || typeof def === "function")) {
      const ks = Object.keys(mod);
      if (ks.every((k) => k === "default" || k === "module.exports")) return def;
    }
    return mod;
  };
  const npm = new Map();
  for (const [path, e] of files) {
    for (const spec of e.imports) {
      if (!spec.startsWith("npm:") || npm.has(spec)) continue;
      const bundled = workerData.npmUrls && workerData.npmUrls[spec];
      if (bundled) {
        npm.set(spec, unwrapNpm(await import(bundled)));
        continue;
      }
      const name = spec.slice(4);
      let url = name;
      try { url = pathToFileURL(createRequire(path).resolve(name)).href; } catch { /* fall back to Node's own resolution */ }
      npm.set(spec, unwrapNpm(await import(url)));
    }
  }
  const RUNTIME = { ...rt, FakeAudio: std.FakeAudio, FakeClock: std.FakeClock, SeededRandom: std.SeededRandom, MemoryLog: std.MemoryLog, FakeFs: std.FakeFs, FakeSpawn: std.FakeSpawn, TestAlloc: std.TestAlloc, ...(native ? { native } : {}) };
  const done = new Map();
  const instantiate = (path) => {
    let ex = done.get(path);
    if (ex) return ex;
    ex = {};
    done.set(path, ex);
    const f = new Function(workerData.rtName, workerData.impName, workerData.exportsName, files.get(path).js);
    f(RUNTIME, (k) => (k.startsWith("npm:") ? npm.get(k) : instantiate(k)), ex);
    return ex;
  };
  const entry = instantiate(workerData.path)[workerData.name];
  if (typeof entry !== "function") throw new Error("isolate entry not found: " + workerData.name);
  rt.isolateMain(entry);
})().catch((e) => {
  try { parentPort.postMessage({ t: { code: "T006", message: String(e) } }); parentPort.close(); } catch { /* the main side is gone */ }
});
`;

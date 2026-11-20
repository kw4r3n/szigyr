// §15.2 isolates: a Port over a message channel, the value transport between isolates, and the
// Worker host. An isolate is a JS Worker that loads the same program and runs one entry function.
import { Worker, parentPort, workerData } from "node:worker_threads";
import { RingRx, RingTx, Vec, ringPack, ringUnpack, type RingShared, type RingWire } from "./collections.ts";
import { asTrap, noteIsolateTrap, task, type ForeignTrap, type Pos } from "./trap.ts";

/** The wire form of one packed value: plain data, or one tagged wrapper (user data only ever
 * appears inside `$rec`, so the tags cannot collide with it). */
function packValue(v: unknown, memo: Map<object, unknown>, transfer: object[]): unknown {
  if (v instanceof Vec) {
    const w = v.pack();
    if (w.buf) transfer.push(w.buf);
    return { $vec: w };
  }
  if (v instanceof RingTx || v instanceof RingRx) {
    let w = memo.get(v.shared);
    if (!w) { w = { $ring: ringPack(v.shared) }; memo.set(v.shared, w); }
    return { $end: w, $tx: v instanceof RingTx };
  }
  if (v !== null && typeof v === "object") {
    if (Array.isArray(v)) return v.map((x) => packValue(x, memo, transfer));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = packValue(x, memo, transfer);
    return { $rec: out };
  }
  return v;
}

function unpackValue(v: unknown, memo: Map<object, RingShared<unknown>>): unknown {
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("$vec" in o) return Vec.unpack(o.$vec as { elem: never });
    if ("$end" in o) {
      const w = o.$end as { $ring: RingWire };
      let s = memo.get(w);
      if (!s) { s = ringUnpack(w.$ring); memo.set(w, s); }
      return o.$tx ? new RingTx(s) : new RingRx(s);
    }
    if ("$rec" in o) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(o.$rec as Record<string, unknown>)) out[k] = unpackValue(x, memo);
      return out;
    }
    if (Array.isArray(v)) return v.map((x) => unpackValue(x, memo));
  }
  return v;
}

/** One channel message: a packed value, a close, or a trap on its way to the managed side (§15.4). */
type Envelope = { d: unknown } | { c: 1 } | { t: ForeignTrap };

interface Channel {
  post(msg: Envelope, transfer?: object[]): void;
  onMessage(f: (msg: Envelope) => void): void;
  onClose(f: () => void): void;
  close(): void;
}

/** §15.2: a Port<S, R> (the type parameters live in the checker; the runtime moves plain values). */
export class Port {
  private ch: Channel;
  private queue: unknown[] = [];
  private waiters: ((v: unknown) => void)[] = [];
  private peerClosed = false;
  private closed = false;
  constructor(ch: Channel) {
    this.ch = ch;
    ch.onMessage((m) => this.onEnvelope(m));
    ch.onClose(() => this.onPeerGone());
  }
  send(x: unknown): void {
    if (this.closed || this.peerClosed) return; // §15.2: a send on a closed port discards the value
    const transfer: object[] = [];
    const wire = packValue(x, new Map(), transfer);
    try { this.ch.post({ d: wire }, transfer); } catch { /* the peer is gone; the value is discarded */ }
  }
  recv(): Promise<unknown> {
    const p = this.queue.length ? Promise.resolve(this.queue.shift())
      : this.peerClosed || this.closed ? Promise.resolve(null)
      : new Promise<unknown>((res) => this.waiters.push(res));
    // §15.4 (2): a foreign trap surfaces before the next task; a recv resumption is one, on both backends
    return p.then((v) => task(v));
  }
  close(): void {
    if (this.closed) return; // Q207: closing twice does nothing
    this.closed = true;
    try { this.ch.post({ c: 1 }); } catch { /* the peer is gone */ }
    this.ch.close();
    this.drain();
  }
  private onEnvelope(m: Envelope): void {
    if ("t" in m) { noteIsolateTrap(m.t); return; }
    if ("c" in m) { this.peerClosed = true; this.drain(); return; }
    const v = unpackValue(m.d, new Map());
    const w = this.waiters.shift();
    if (w) w(v); else this.queue.push(v);
  }
  private onPeerGone(): void { this.peerClosed = true; this.drain(); }
  /** Delivered messages are read first; only then does a pending recv resolve null (Q207). */
  private drain(): void {
    while (this.waiters.length && this.queue.length) this.waiters.shift()!(this.queue.shift());
    if ((this.peerClosed || this.closed) && !this.queue.length) while (this.waiters.length) this.waiters.shift()!(null);
  }
}

/** What an isolate needs to load the same program: the emitted module factories and the hosts' parts. */
export interface IsolateProgram {
  files: [string, { js: string; imports: string[]; calls: [string, Pos][] }][];
  runtimeUrl: string;
  stdUrl: string;
  nativePath: string | null;
  rtName: string;
  impName: string;
  exportsName: string;
  framePattern: string;
}
let isolateProgram: IsolateProgram | undefined;
/** The host (the compiler's loader) installs the program a `spawnIsolate` call should load. */
export function setIsolateProgram(p: IsolateProgram | undefined): void { isolateProgram = p; }

const liveWorkers = new Set<Worker>();
/** §15.2: starts an isolate running the entry function `name` of the module at `path`; returns its port without waiting. */
export function spawnIsolate(path: string, name: string): Port {
  const prog = isolateProgram;
  if (!prog) throw new Error("spawnIsolate: no isolate program is installed");
  const w = new Worker(BOOTSTRAP, { eval: true, workerData: { ...prog, path, name } });
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
export function isolateMain(f: (port: Port) => unknown): void {
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
      await f(port);
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
  const std = await import(workerData.stdUrl);
  let native;
  if (workerData.nativePath) {
    const m = { exports: {} };
    process.dlopen(m, workerData.nativePath);
    native = m.exports;
    // D124: init() resets the shared foreign-trap record, so a trap already recorded is claimed
    // first and forwarded; loading this isolate cannot erase it (§15.4).
    const pending = native.sts_poll();
    native.init({
      trap: (code, file, line, col) => rt.trap("T" + String(code).padStart(3, "0"), "trap in C", file ? { file, line, col } : undefined),
      create: (alloc, cap, elem) => rt.Vec.create(alloc, cap, elem),
      createPool: (alloc, cap, elem) => rt.Pool.create(alloc, cap, elem),
      createArena: (alloc, bytes) => rt.Arena.create(alloc, bytes),
      createRing: (alloc, cap, elem) => rt.Ring.create(alloc, cap, elem),
      adoptRing: (v, elem) => v.adopt(elem),
      adoptPool: (v, elem) => v.adopt(elem),
      adopt: (v, elem) => v.adopt(elem),
      reserve: (v, cap, len) => v.reserve(cap, len),
    });
    if (Array.isArray(pending)) parentPort.postMessage({ t: { code: "T" + String(pending[0]).padStart(3, "0"), file: pending[1], line: pending[2], col: pending[3] } });
    rt.setForeignTrapCheck(() => {
      const v = native.sts_poll();
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
  const npm = new Map();
  for (const [path, e] of files) {
    for (const spec of e.imports) {
      if (!spec.startsWith("npm:") || npm.has(spec)) continue;
      const name = spec.slice(4);
      let url = name;
      try { url = pathToFileURL(createRequire(path).resolve(name)).href; } catch { /* fall back to Node's own resolution */ }
      npm.set(spec, await import(url));
    }
  }
  const RUNTIME = { ...rt, FakeClock: std.FakeClock, SeededRandom: std.SeededRandom, MemoryLog: std.MemoryLog, FakeFs: std.FakeFs, TestAlloc: std.TestAlloc, ...(native ? { native } : {}) };
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

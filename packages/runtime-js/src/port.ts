// Platform-neutral isolate Port / Channel / wire serializer (SPEC §15.2, zero Node imports).
import { Arena, Pool, RingRx, RingTx, Vec, ringPack, ringUnpack, type ArenaWire, type PoolWire, type RingShared, type RingWire } from "./collections.ts";
import { noteIsolateTrap, task, type ForeignTrap, type Pos } from "./trap.ts";
import type { WasmMeta } from "./wasm-bridge.ts";

/** The wire form of one packed value: plain data, or one tagged wrapper (user data only ever
 * appears inside `$rec`, so the tags cannot collide with it). */
export function packValue(v: unknown, memo: Map<object, unknown>, transfer: object[]): unknown {
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
  if (v instanceof Pool) {
    const w = v.pack();
    transfer.push(w.gens, w.occ, w.nextFree);
    if (w.buf) transfer.push(w.buf);
    return { $pool: w };
  }
  if (v instanceof Arena) {
    const w = v.pack();
    transfer.push(w.buf);
    return { $arena: w };
  }
  if (v !== null && typeof v === "object") {
    if (Array.isArray(v)) return v.map((x) => packValue(x, memo, transfer));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = packValue(x, memo, transfer);
    return { $rec: out };
  }
  return v;
}

export function unpackValue(v: unknown, memo: Map<object, RingShared<unknown>>): unknown {
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("$vec" in o) return Vec.unpack(o.$vec as { elem: never });
    if ("$end" in o) {
      const w = o.$end as { $ring: RingWire };
      let s = memo.get(w);
      if (!s) { s = ringUnpack(w.$ring); memo.set(w, s); }
      return o.$tx ? new RingTx(s) : new RingRx(s);
    }
    if ("$pool" in o) return Pool.unpack(o.$pool as PoolWire);
    if ("$arena" in o) return Arena.unpack(o.$arena as ArenaWire);
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
export type Envelope = { d: unknown } | { c: 1 } | { t: ForeignTrap };

export interface Channel {
  post(msg: Envelope, transfer?: object[]): void;
  onMessage(f: (msg: Envelope) => void): void;
  onClose(f: () => void): void;
  close(): void;
  onWait?(): void;
}

/** §15.2: a Port<S, R> (the type parameters live in the checker; the runtime moves plain values). */
export class Port {
  private ch: Channel;
  // shortcut: unbounded; memory grows while the receiver does not read. Upgrade when a program streams without reading, which needs a SPEC rule for backpressure (Q260).
  private queue: unknown[] = [];
  private waiters: ((v: unknown) => void)[] = [];
  private peerClosed = false;
  private closed = false;
  constructor(ch: Channel) {
    this.ch = ch;
    ch.onMessage((m) => this.onEnvelope(m));
    ch.onClose(() => this.onPeerGone());
  }
  get waiting(): boolean { return this.waiters.length > 0 && this.queue.length === 0 && !this.closed && !this.peerClosed; }
  send(x: unknown): void {
    if (this.closed || this.peerClosed) return; // §15.2: a send on a closed port discards the value
    const transfer: object[] = [];
    const wire = packValue(x, new Map(), transfer);
    try { this.ch.post({ d: wire }, transfer); } catch { /* the peer is gone; the value is discarded */ }
  }
  recv(): Promise<unknown> {
    const p = this.queue.length ? Promise.resolve(this.queue.shift())
      : this.peerClosed || this.closed ? Promise.resolve(null)
      : new Promise<unknown>((res) => { this.waiters.push(res); this.ch.onWait?.(); });
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
  nativeProg: number | null; // what main's `init` returned: its program's flag and record (D165)
  wasmBytes?: Uint8Array | null;
  wasmMeta?: WasmMeta | null;
  npmUrls?: Record<string, string>;
  rtName: string;
  impName: string;
  exportsName: string;
  framePattern: string;
}
let isolateProgram: IsolateProgram | undefined;
/** The host (the compiler's loader) installs the program a `spawnIsolate` call should load. */
export function setIsolateProgram(p: IsolateProgram | undefined): void { isolateProgram = p; }
export function getIsolateProgram(): IsolateProgram | undefined { return isolateProgram; }

const fakeIsolateClosers = new Set<() => void>();
/** Registers an in-process FakeSpawn isolate session so test/main exit can close dangling listeners. */
export function registerFakeIsolate(close: () => void): () => void {
  fakeIsolateClosers.add(close);
  return () => { fakeIsolateClosers.delete(close); };
}
/** Closes all active in-process FakeSpawn sessions and clears their timers. */
export function stopFakeIsolates(): void {
  for (const close of [...fakeIsolateClosers]) close();
  fakeIsolateClosers.clear();
}

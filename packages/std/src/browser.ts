// Browser standard library (zero `node:*` imports; Q282, Q283, Q285).
import {
  Arena, Pool, RingRx, RingTx, Vec, asTrap, capturing, cast, err, isTrap, noteIsolateTrap, ok, ringPushRaw, stopIsolates, takeIsolateTrap, type Pos, type Result, type RingShared, type WasmMeta,
} from "../../runtime-js/src/browser.ts";
import { ALLOC, type Audio, type AudioCallbackSpec, type AudioConfig, type AudioStream, type Clock, type Fs, type IoError, type Js, type JsError, type JsRef, type Log, type Random, type System } from "./types.ts";

export * from "./types.ts";
export * from "./fake.ts";

export function createBrowserLog(
  stdout: (s: string) => void = (m) => console.log(m.replace(/\n$/, "")),
  stderr: (s: string) => void = (m) => console.error(m.replace(/\n$/, "")),
): Log {
  return { info: (m) => stdout(m + "\n"), warn: (m) => stderr(m + "\n"), error: (m) => stderr(m + "\n") };
}

export const browserClock: Clock = {
  nowMs: () => Date.now(),
  sleep: (ms) => {
    const d = Number.isFinite(ms) && ms > 0 ? Math.min(ms, 2147483647) : 0;
    return new Promise((r) => setTimeout(r, d));
  },
};

export const browserRandom: Random = {
  nextF64: () => Math.random(),
  nextU32: () => Math.floor(Math.random() * 2 ** 32),
};

export const browserFs: Fs = {
  readText: () => err({ code: "ENOSYS", message: "Fs is not available in browser" }),
  writeText: () => err({ code: "ENOSYS", message: "Fs is not available in browser" }),
};

const jsError = (e: unknown): JsError => ({ code: e instanceof Error ? e.name : "Error", message: e instanceof Error ? e.message : String(e) });
const guard = <T>(f: () => T): Result<T, JsError> => { try { return ok(f()); } catch (e) { if (isTrap(e)) throw e; return err(jsError(e)); } };

export const browserJs: Js = {
  call: (f, args) => guard(() => (f as (...a: JsRef[]) => JsRef)(...args)),
  get: (obj, key) => guard(() => (obj as Record<string, JsRef>)[key]),
  await: async (v) => { try { return ok(await v); } catch (e) { if (isTrap(e)) throw e; return err(jsError(e)); } },
  decode: (v, desc) => cast(v, desc),
  encode: (v) => v,
  callback: (f, desc) => (...a: unknown[]): void => { f(cast(a[0], desc)); },
};

export interface BrowserAudioOptions {
  workletUrl: string | URL;
  wasmBytes: Uint8Array | null;
  wasmMeta: WasmMeta | null;
  createAudioContext?: (cfg: AudioConfig) => AudioContext;
  onNode?: (node: AudioWorkletNode, ctx: AudioContext) => void | Promise<void>;
}

const activeAudioClosers = new Set<() => Promise<void>>();
export async function stopBrowserAudioStreams(): Promise<void> {
  for (const fn of [...activeAudioClosers]) await fn();
}

const loadedModules = new WeakMap<AudioContext, Promise<void>>();

export function createBrowserAudio(opts: BrowserAudioOptions): Audio {
  return {
    async open(config: AudioConfig, state: unknown, cb: AudioCallbackSpec): Promise<Result<AudioStream, IoError>> {
      if (!Number.isInteger(config.sampleRate) || config.sampleRate <= 0 || config.sampleRate > 0x7fffffff || !Number.isInteger(config.channels) || config.channels < 1 || config.channels > 32) {
        return err({ code: "EINVAL", message: `invalid audio config: sampleRate=${config.sampleRate}, channels=${config.channels}` });
      }
      if (typeof AudioContext === "undefined" && !opts.createAudioContext) {
        return err({ code: "ENOSYS", message: "Web Audio API is unavailable" });
      }
      const { sampleRate, channels } = config;
      const ctx = opts.createAudioContext ? opts.createAudioContext(config) : new AudioContext({ sampleRate });
      const ownsCtx = !opts.createAudioContext;
      const cleanup = async (): Promise<void> => { if (ownsCtx && ctx.state !== "closed") try { await ctx.close(); } catch { /* ignored */ } };

      try {
        if (ctx.state === "suspended") await ctx.resume();
        let modP = loadedModules.get(ctx);
        if (!modP) {
          modP = ctx.audioWorklet.addModule(typeof opts.workletUrl === "string" ? opts.workletUrl : opts.workletUrl.href);
          loadedModules.set(ctx, modP);
        }
        await modP;
      } catch (e) {
        await cleanup();
        return err({ code: "EIO", message: e instanceof Error ? e.message : String(e) });
      }

      const fallbackRings = new Map<number, RingShared<unknown>>();
      let nextRingId = 1;
      const packState = (v: unknown, memo = new Map<object, unknown>()): unknown => {
        if (v instanceof Vec) return { $stsVec: v.pack() };
        if (v instanceof Pool) return { $stsPool: v.pack() };
        if (v instanceof Arena) return { $stsArena: v.pack() };
        if (v instanceof RingTx || v instanceof RingRx) {
          const hit = memo.get(v.shared);
          if (hit) return { $stsRing: hit, tx: v instanceof RingTx };
          if (v.shared.atomic) {
            const spec = { atomic: true, sab: v.sab, cap: v.cap, elem: v.shared.elem };
            memo.set(v.shared, spec);
            return { $stsRing: spec, tx: v instanceof RingTx };
          }
          const id = nextRingId++;
          fallbackRings.set(id, v.shared as RingShared<unknown>);
          const copy = v.sab ? v.sab.slice(0) : null;
          const spec = { atomic: false, id, buf: copy, cap: v.cap, elem: v.shared.elem };
          memo.set(v.shared, spec);
          return { $stsRing: spec, tx: v instanceof RingTx };
        }
        if (v !== null && typeof v === "object") {
          if (Array.isArray(v)) return v.map((x) => packState(x, memo));
          const out: Record<string, unknown> = {};
          for (const [k, x] of Object.entries(v)) out[k] = packState(x, memo);
          return out;
        }
        return v;
      };

      const stateWire = packState(state);
      const node = new AudioWorkletNode(ctx, "sts-audio-processor", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [channels],
        processorOptions: { wasmBytes: opts.wasmBytes, wasmMeta: opts.wasmMeta, cbId: cb.id, channels, stateWire },
      });

      for (const shared of fallbackRings.values()) {
        shared.onPush = (bytes: Uint8Array) => {
          for (const [rid, sh] of fallbackRings) {
            if (sh === shared) {
              try { node.port.postMessage({ k: "r", i: rid, b: bytes }, [bytes.buffer]); } catch { /* closing */ }
              break;
            }
          }
        };
      }

      let readyRes!: () => void;
      let readyRej!: (e: Error) => void;
      const readyP = new Promise<void>((res, rej) => { readyRes = res; readyRej = rej; });
      node.port.onmessage = (ev: MessageEvent) => {
        const m = ev.data as Record<string, unknown>;
        if (!m || typeof m !== "object") return;
        if (m.k === "ready") readyRes();
        else if (m.k === "error") readyRej(new Error(String(m.message ?? "worklet init error")));
        else if (m.k === "r") {
          const sh = fallbackRings.get(m.i as number);
          if (sh) ringPushRaw(sh, new Uint8Array(m.b as ArrayBuffer));
        } else if (m.k === "trap") {
          noteIsolateTrap({ code: String(m.code), ...(m.file ? { file: String(m.file), line: Number(m.line), col: Number(m.col) } : {}) });
        }
      };

      try {
        await readyP;
        await opts.onNode?.(node, ctx);
        node.connect(ctx.destination);
      } catch (e) {
        for (const sh of fallbackRings.values()) sh.onPush = undefined;
        try { node.port.postMessage({ k: "close" }); } catch { /* ignored */ }
        try { node.disconnect(); } catch { /* ignored */ }
        await cleanup();
        return err({ code: "EIO", message: e instanceof Error ? e.message : String(e) });
      }

      let closed = false;
      const close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        activeAudioClosers.delete(close);
        for (const sh of fallbackRings.values()) sh.onPush = undefined;
        try { node.port.postMessage({ k: "close" }); } catch { /* ignored */ }
        try { node.disconnect(); } catch { /* ignored */ }
        await cleanup();
      };
      activeAudioClosers.add(close);
      return ok({ sampleRate, channels, close, disposeAsync: close, isOpen: () => !closed });
    },
  };
}

export interface BrowserRunOptions {
  workletUrl: string | URL;
  wasmBytes: Uint8Array | null;
  wasmMeta: WasmMeta | null;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  createAudioContext?: (cfg: AudioConfig) => AudioContext;
  onNode?: (node: AudioWorkletNode, ctx: AudioContext) => void | Promise<void>;
}

export interface BrowserRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly trap: { readonly code: string; readonly file: string; readonly line: number; readonly col: number; readonly message?: string } | null;
}

export function createBrowserSystem(opts: BrowserRunOptions): System {
  return {
    alloc: ALLOC,
    fs: browserFs,
    clock: browserClock,
    random: browserRandom,
    log: createBrowserLog(opts.stdout, opts.stderr),
    js: browserJs,
    audio: createBrowserAudio(opts),
  };
}

export async function runMainBrowser(main: (sys: System) => void | Promise<void>, opts: BrowserRunOptions): Promise<BrowserRunResult> {
  takeIsolateTrap();
  let stdout = "";
  let stderr = "";
  const sys = createBrowserSystem({ ...opts, stdout: (s) => { stdout += s; opts.stdout?.(s); }, stderr: (s) => { stderr += s; opts.stderr?.(s); } });
  let ownTrap: { code: string; file: string; line: number; col: number } | null = null;
  try {
    const rejected = await capturing(() => main(sys));
    if (rejected.length) throw rejected[0];
  } catch (e) {
    const t = asTrap(e);
    if (!t) throw e;
    ownTrap = { code: t.code, file: t.pos?.file ?? "", line: t.pos?.line ?? 0, col: t.pos?.col ?? 0 };
  } finally {
    await Promise.all([stopIsolates(), stopBrowserAudioStreams()]);
  }
  const f = takeIsolateTrap();
  const iso = f ? { code: f.code, file: f.file ?? "", line: f.line ?? 0, col: f.col ?? 0, ...(f.message ? { message: f.message } : {}) } : null;
  return { stdout, stderr, trap: ownTrap ?? iso };
}

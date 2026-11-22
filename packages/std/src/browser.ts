// Browser standard library (zero `node:*` imports; Q282, Q283, Q285).
import {
  Arena, Pool, RingRx, RingTx, Vec, asTrap, capturing, cast, err, isTrap, noteIsolateTrap, ok, ringPushRaw, spawnIsolate, stopFakeIsolates, stopIsolates, takeIsolateTrap, type Pos, type Result, type RingShared, type Slice, type WasmMeta,
} from "../../runtime-js/src/browser.ts";
import {
  ALLOC, type Audio, type AudioCallbackSpec, type AudioConfig, type AudioStream, type Clock,
  type Display, type DisplayColor, type DisplayConfig, type DisplayEvent, type DisplaySurface,
  type Fs, type IoError, type Js, type JsError, type JsRef, type Log, type Net, type Proc, type Random, type Spawn, type System,
} from "./types.ts";
import { readDisplayRgba, validateDisplayConfig, webFetch } from "./fake.ts";

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
  readBytes: () => err({ code: "ENOSYS", message: "Fs is not available in browser" }),
  writeBytes: () => err({ code: "ENOSYS", message: "Fs is not available in browser" }),
  exists: () => false,
  stat: () => err({ code: "ENOSYS", message: "Fs is not available in browser" }),
  readDir: () => err({ code: "ENOSYS", message: "Fs is not available in browser" }),
  mkdir: () => err({ code: "ENOSYS", message: "Fs is not available in browser" }),
  remove: () => err({ code: "ENOSYS", message: "Fs is not available in browser" }),
  rename: () => err({ code: "ENOSYS", message: "Fs is not available in browser" }),
  writeTextAtomic: () => err({ code: "ENOSYS", message: "Fs is not available in browser" }),
  writeBytesAtomic: () => err({ code: "ENOSYS", message: "Fs is not available in browser" }),
};

const browserProcExitCodes = new WeakMap<Proc, () => number>();
export const getBrowserProcExitCode = (proc: Proc): number => browserProcExitCodes.get(proc)?.() ?? 0;

export function createBrowserProc(): Proc {
  let exitCode = 0;
  const proc: Proc = {
    run: async () => err({ code: "ENOSYS", message: "Proc.run is not available in browser" }),
    env: () => null,
    cwd: () => "/",
    args: () => [],
    setExitCode: (code: number) => { exitCode = code & 0xff; },
  };
  browserProcExitCodes.set(proc, () => exitCode);
  return proc;
}
export const browserProc: Proc = createBrowserProc();

export const browserNet: Net = {
  fetch: webFetch,
  serve: async () => err({ code: "ENOSYS", message: "Net.serve is not available in browser" }),
  serveRaw: async () => err({ code: "ENOSYS", message: "Net.serveRaw is not available in browser" }),
};

export const browserSpawn: Spawn = {
  isolate: (path, name) => spawnIsolate(path, name),
};

const jsError = (e: unknown): JsError => ({ code: e instanceof Error ? e.name : "Error", message: e instanceof Error ? e.message : String(e) });
const guard = <T>(f: () => T): Result<T, JsError> => { try { return ok(f()); } catch (e) { if (isTrap(e)) throw e; return err(jsError(e)); } };

export const browserJs: Js = {
  call: (f, args) => guard(() => (f as (...a: JsRef[]) => JsRef)(...args)),
  new: (ctor, args) => guard(() => Reflect.construct(ctor as new (...a: JsRef[]) => JsRef, args)),
  invoke: (obj, method, args) => guard(() => {
    const f = (obj as Record<string, unknown>)[method];
    if (typeof f !== "function") throw new TypeError(`${method} is not a function`);
    return Reflect.apply(f, obj, args);
  }),
  get: (obj, key) => guard(() => (obj as Record<string, JsRef>)[key]),
  set: (obj, key, value) => guard(() => { (obj as Record<string, JsRef>)[key] = value; return null; }),
  object: (entries) => {
    const o: Record<string, JsRef> = {};
    for (const e of entries) Object.defineProperty(o, e.key, { value: e.value, enumerable: true, writable: true, configurable: true });
    return o;
  },
  await: async (v) => { try { return ok(await v); } catch (e) { if (isTrap(e)) throw e; return err(jsError(e)); } },
  decode: (v, desc) => cast(v, desc),
  encode: (v) => v,
  callback: (f, desc) => (...a: unknown[]): void => { f(cast(a[0], desc)); },
  fn: (f) => (...args: JsRef[]): JsRef => f(args),
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
        if (v instanceof Vec) return { $szVec: v.pack() };
        if (v instanceof Pool) return { $szPool: v.pack() };
        if (v instanceof Arena) return { $szArena: v.pack() };
        if (v instanceof RingTx || v instanceof RingRx) {
          const hit = memo.get(v.shared);
          if (hit) return { $szRing: hit, tx: v instanceof RingTx };
          if (v.shared.atomic) {
            const spec = { atomic: true, sab: v.sab, cap: v.cap, elem: v.shared.elem };
            memo.set(v.shared, spec);
            return { $szRing: spec, tx: v instanceof RingTx };
          }
          const id = nextRingId++;
          fallbackRings.set(id, v.shared as RingShared<unknown>);
          const copy = v.sab ? v.sab.slice(0) : null;
          const spec = { atomic: false, id, buf: copy, cap: v.cap, elem: v.shared.elem };
          memo.set(v.shared, spec);
          return { $szRing: spec, tx: v instanceof RingTx };
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
      const node = new AudioWorkletNode(ctx, "szigyr-audio-processor", {
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

export interface BrowserDisplayOptions {
  canvas?: HTMLCanvasElement;
  canvasContainer?: HTMLElement;
}

const activeDisplayClosers = new Set<() => Promise<void>>();
export async function stopBrowserDisplaySurfaces(): Promise<void> {
  for (const fn of [...activeDisplayClosers]) await fn();
}

function normalizeDomKey(k: string): string {
  if (k === " ") return "Space";
  if (k.length === 1 && k >= "A" && k <= "Z") return k.toLowerCase();
  return k;
}

const rgbaCss = (c: DisplayColor): string => `rgba(${c.r & 255},${c.g & 255},${c.b & 255},${(c.a & 255) / 255})`;

export function createBrowserDisplay(opts: BrowserDisplayOptions = {}): Display {
  return {
    async open(config: DisplayConfig): Promise<Result<DisplaySurface, IoError>> {
      const valid = validateDisplayConfig(config);
      if (valid.kind === "err") return valid;
      if (typeof document === "undefined" && !opts.canvas) {
        return err({ code: "ENOSYS", message: "HTML Canvas 2D is unavailable" });
      }
      const { width, height } = valid.value;
      const owned = !opts.canvas;
      let canvas: HTMLCanvasElement;
      if (opts.canvas) {
        canvas = opts.canvas;
      } else {
        canvas = document.createElement("canvas");
        canvas.id = "szigyr-canvas";
        canvas.tabIndex = 0;
        canvas.style.imageRendering = "pixelated";
        canvas.style.outline = "none";
        canvas.style.display = "block";
        canvas.style.border = "1px solid #323944";
        const host = opts.canvasContainer ?? document.getElementById("szigyr-display") ?? document.body;
        if (!host) return err({ code: "EIO", message: "Display.open: no DOM container available" });
        host.appendChild(canvas);
        if (config.title) document.title = config.title;
      }
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        if (owned) canvas.remove();
        return err({ code: "EIO", message: "Display.open: failed to create 2D context" });
      }

      const queue: DisplayEvent[] = [];
      let closed = false;
      let pointerDownActive = false;
      let tmpCanvas: HTMLCanvasElement | undefined;
      let tmpCtx: CanvasRenderingContext2D | null = null;

      const toCoords = (ev: { clientX: number; clientY: number }): { x: number; y: number } => {
        const rect = canvas.getBoundingClientRect();
        const rw = rect.width > 0 ? rect.width : width;
        const rh = rect.height > 0 ? rect.height : height;
        return {
          x: ((ev.clientX - rect.left) / rw) * width,
          y: ((ev.clientY - rect.top) / rh) * height,
        };
      };

      const onPointerDown = (ev: PointerEvent): void => {
        try { canvas.focus({ preventScroll: true }); } catch { /* ignore */ }
        try { canvas.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
        pointerDownActive = true;
        const p = toCoords(ev);
        queue.push({ kind: "pointerDown", x: p.x, y: p.y, button: ev.button & 0xff });
      };
      const onPointerMove = (ev: PointerEvent): void => {
        const p = toCoords(ev);
        queue.push({ kind: "pointerMove", x: p.x, y: p.y, buttons: ev.buttons & 0xff });
      };
      const onPointerUp = (ev: PointerEvent): void => {
        if (!pointerDownActive) return;
        pointerDownActive = false;
        const p = toCoords(ev);
        queue.push({ kind: "pointerUp", x: p.x, y: p.y, button: ev.button & 0xff });
      };
      const onWheel = (ev: WheelEvent): void => {
        ev.preventDefault();
        const p = toCoords(ev);
        queue.push({ kind: "wheel", x: p.x, y: p.y, dx: ev.deltaX, dy: ev.deltaY });
      };
      const isFormTarget = (t: EventTarget | null): boolean => {
        const tag = (t as { tagName?: string } | null)?.tagName;
        return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      };
      const onKeyDown = (ev: KeyboardEvent): void => {
        if (isFormTarget(ev.target)) return;
        const key = normalizeDomKey(ev.key);
        if (key === "Space" || key.startsWith("Arrow")) ev.preventDefault();
        queue.push({ kind: "keyDown", key, repeat: ev.repeat, shift: ev.shiftKey, ctrl: ev.ctrlKey, alt: ev.altKey });
      };
      const onKeyUp = (ev: KeyboardEvent): void => {
        if (isFormTarget(ev.target)) return;
        queue.push({ kind: "keyUp", key: normalizeDomKey(ev.key), shift: ev.shiftKey, ctrl: ev.ctrlKey, alt: ev.altKey });
      };

      const winTarget: EventTarget = typeof window !== "undefined" ? window : canvas;
      canvas.addEventListener("pointerdown", onPointerDown);
      canvas.addEventListener("pointermove", onPointerMove);
      canvas.addEventListener("wheel", onWheel, { passive: false });
      winTarget.addEventListener("pointerup", onPointerUp as EventListener);
      winTarget.addEventListener("keydown", onKeyDown as EventListener);
      winTarget.addEventListener("keyup", onKeyUp as EventListener);

      const close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        activeDisplayClosers.delete(close);
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("pointermove", onPointerMove);
        canvas.removeEventListener("wheel", onWheel);
        winTarget.removeEventListener("pointerup", onPointerUp as EventListener);
        winTarget.removeEventListener("keydown", onKeyDown as EventListener);
        winTarget.removeEventListener("keyup", onKeyUp as EventListener);
        if (owned) canvas.remove();
      };
      activeDisplayClosers.add(close);

      const surface: DisplaySurface = {
        width,
        height,
        clear: (color: DisplayColor): void => {
          if (closed) return;
          ctx.clearRect(0, 0, width, height);
          if ((color.a & 255) > 0) {
            ctx.fillStyle = rgbaCss(color);
            ctx.fillRect(0, 0, width, height);
          }
        },
        fillRect: (x: number, y: number, w: number, h: number, color: DisplayColor): void => {
          if (closed || !(w > 0 && h > 0)) return;
          ctx.fillStyle = rgbaCss(color);
          ctx.fillRect(x, y, w, h);
        },
        strokeRect: (x: number, y: number, w: number, h: number, color: DisplayColor): void => {
          if (closed || !(w > 0 && h > 0)) return;
          ctx.strokeStyle = rgbaCss(color);
          ctx.lineWidth = 1;
          ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));
        },
        drawLine: (x1: number, y1: number, x2: number, y2: number, color: DisplayColor): void => {
          if (closed) return;
          ctx.strokeStyle = rgbaCss(color);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x1 + 0.5, y1 + 0.5);
          ctx.lineTo(x2 + 0.5, y2 + 0.5);
          ctx.stroke();
        },
        drawText: (x: number, y: number, text: string, color: DisplayColor): void => {
          if (closed) return;
          ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, monospace";
          ctx.textBaseline = "top";
          ctx.textAlign = "left";
          ctx.fillStyle = rgbaCss(color);
          ctx.fillText(text, x, y);
        },
        blitRgba: (pixels: Slice<number> | Vec<number>, srcWidth: number, srcHeight: number, dstX: number, dstY: number, dstW: number, dstH: number, pos?: Pos): void => {
          const raw = readDisplayRgba(pixels, srcWidth, srcHeight, pos);
          if (closed || srcWidth === 0 || srcHeight === 0 || !(dstW > 0 && dstH > 0)) return;
          if (!tmpCanvas) {
            const doc = canvas.ownerDocument ?? document;
            tmpCanvas = doc.createElement("canvas");
            tmpCtx = tmpCanvas.getContext("2d");
          }
          if (!tmpCanvas || !tmpCtx) return;
          if (tmpCanvas.width !== srcWidth || tmpCanvas.height !== srcHeight) {
            tmpCanvas.width = srcWidth;
            tmpCanvas.height = srcHeight;
          }
          const need = srcWidth * srcHeight * 4;
          const img = new ImageData(srcWidth, srcHeight);
          img.data.set(raw.length === need ? raw : raw.subarray(0, need));
          tmpCtx.putImageData(img, 0, 0);
          const prev = ctx.imageSmoothingEnabled;
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(tmpCanvas, dstX, dstY, dstW, dstH);
          ctx.imageSmoothingEnabled = prev;
        },
        present: async (): Promise<void> => {
          if (closed) return;
          await new Promise<void>((resolve) => {
            let done = false;
            const finish = (): void => {
              if (done) return;
              done = true;
              clearTimeout(timer);
              resolve();
            };
            const timer = setTimeout(finish, 50);
            if (typeof requestAnimationFrame === "function") requestAnimationFrame(finish);
            else queueMicrotask(finish);
          });
        },
        pollEvents: (): DisplayEvent[] => (closed ? [] : queue.splice(0)),
        close,
        disposeAsync: close,
        isOpen: (): boolean => !closed,
      };
      return ok(surface);
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
  canvas?: HTMLCanvasElement;
  canvasContainer?: HTMLElement;
}

export interface BrowserRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly trap: { readonly code: string; readonly file: string; readonly line: number; readonly col: number; readonly message?: string } | null;
  readonly exitCode?: number;
}

export function createBrowserSystem(opts: BrowserRunOptions): System {
  return {
    alloc: ALLOC,
    fs: browserFs,
    clock: browserClock,
    random: browserRandom,
    log: createBrowserLog(opts.stdout, opts.stderr),
    js: browserJs,
    spawn: browserSpawn,
    audio: createBrowserAudio(opts),
    display: createBrowserDisplay(opts),
    net: browserNet,
    proc: createBrowserProc(),
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
    stopFakeIsolates();
    await Promise.all([stopIsolates(), stopBrowserAudioStreams(), stopBrowserDisplaySurfaces()]);
  }
  const f = takeIsolateTrap();
  const iso = f ? { code: f.code, file: f.file ?? "", line: f.line ?? 0, col: f.col ?? 0, ...(f.message ? { message: f.message } : {}) } : null;
  const trap = ownTrap ?? iso;
  const exitCode = !trap ? getBrowserProcExitCode(sys.proc) : 0;
  return { stdout, stderr, trap, ...(exitCode ? { exitCode } : {}) };
}

import {
  Port, Slice, asTrap, err, noteIsolateTrap, ok, readU8Slice, registerFakeIsolate, replaceU8Vec, trap,
  type Channel, type Envelope, type ForeignTrap, type Pos, type Vec,
} from "../../runtime-js/src/index.ts";
import { ALLOC, type Alloc, type Audio, type AudioCallbackSpec, type AudioConfig, type AudioStream, type Clock, type Fs, type Log, type Random, type Spawn } from "./types.ts";

export class FakeClock implements Clock {
  private ms: number;
  private constructor(ms: number) { this.ms = ms; }
  static create(startMs: number): FakeClock { return new FakeClock(startMs); }
  nowMs(): number { return this.ms; }
  advance(ms: number): void { this.ms += ms; }
  async sleep(ms: number): Promise<void> { if (Number.isFinite(ms) && ms > 0) this.ms += ms; }
}

/** mulberry32 (D020). Output is a function of the seed only. */
export class SeededRandom implements Random {
  private state: number;
  private constructor(state: number) { this.state = state; }
  static create(seed: number): SeededRandom { return new SeededRandom(seed >>> 0); }
  nextU32(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }
  nextF64(): number { return this.nextU32() / 2 ** 32; }
}

export interface LogEntry { readonly level: "info" | "warn" | "error"; readonly message: string }
export class MemoryLog implements Log {
  private readonly log: LogEntry[] = [];
  static create(): MemoryLog { return new MemoryLog(); }
  info(message: string): void { this.log.push({ level: "info", message }); }
  warn(message: string): void { this.log.push({ level: "warn", message }); }
  error(message: string): void { this.log.push({ level: "error", message }); }
  /** A copy: later logging does not change a returned array. */
  entries(): LogEntry[] { return this.log.map((e) => ({ ...e })); }
}

const utf8Enc = new TextEncoder();
const utf8Dec = new TextDecoder("utf-8", { fatal: false });

export class FakeFs implements Fs {
  private readonly files = new Map<string, Uint8Array>();
  static create(): FakeFs { return new FakeFs(); }
  readText(path: string) {
    const b = this.files.get(path);
    return b === undefined ? err({ code: "ENOENT", message: `no such file: ${path}` }) : ok(utf8Dec.decode(b));
  }
  writeText(path: string, text: string) { this.files.set(path, utf8Enc.encode(text)); return ok(null); }
  readBytes(path: string, dst: Vec<number>) {
    const b = this.files.get(path);
    if (b === undefined) return err({ code: "ENOENT", message: `no such file: ${path}` });
    if (b.byteLength > 0xffffffff) return err({ code: "EFBIG", message: "file exceeds usize limit (4GiB)" });
    replaceU8Vec(dst, b);
    return ok(b.byteLength);
  }
  writeBytes(path: string, data: Slice<number> | Vec<number>) {
    this.files.set(path, new Uint8Array(readU8Slice(data)));
    return ok(null);
  }
}

export class TestAlloc {
  static create(): Alloc { return ALLOC; }
}

interface FakeStreamState {
  readonly channels: number;
  readonly isOpen: () => boolean;
  readonly close: () => Promise<void>;
  readonly render: (out: Float32Array, frames: number) => void;
}

export class FakeAudio implements Audio {
  private active: FakeStreamState | undefined;
  static create(): FakeAudio { return new FakeAudio(); }

  async open(config: AudioConfig, state: unknown, cb: AudioCallbackSpec) {
    if (!Number.isInteger(config.sampleRate) || config.sampleRate <= 0 || config.sampleRate > 0x7fffffff || !Number.isInteger(config.channels) || config.channels < 1 || config.channels > 32) {
      return err({ code: "EINVAL", message: `invalid audio config: sampleRate=${config.sampleRate}, channels=${config.channels}` });
    }
    if (this.active?.isOpen()) await this.active.close();
    const { sampleRate, channels } = config;
    let closed = false;
    const cInit = cb.native?.[`sz_audio_fake_init_${cb.id}`] as ((s: unknown) => unknown) | undefined;
    const cRender = cb.native?.[`sz_audio_fake_render_${cb.id}`] as ((ctx: unknown, out: Float32Array, frames: number) => void) | undefined;
    const cFree = cb.native?.[`sz_audio_fake_free_${cb.id}`] as ((ctx: unknown) => void) | undefined;
    const wasmMod = !cInit ? (cb.native?.[`sz_audio_${cb.id}`] as { init(s: unknown): number; render(b: number, out: Float32Array, f: number): void; free(b: number): void } | undefined) : undefined;
    let cCtx: unknown;
    let wasmBox = 0;
    if (cInit) cCtx = cInit(state);
    else if (wasmMod) wasmBox = wasmMod.init(state);

    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      if (cCtx !== undefined) { const x = cCtx; cCtx = undefined; cFree?.(x); }
      if (wasmBox) { const b = wasmBox; wasmBox = 0; wasmMod?.free(b); }
    };
    const render = (out: Float32Array, frames: number): void => {
      if (cRender) cRender(cCtx, out, frames);
      else if (wasmMod) wasmMod.render(wasmBox, out, frames);
      else cb.fn(state, new Slice<number>(out, 0, out.length), frames);
    };
    this.active = { channels, isOpen: () => !closed, close, render };
    const stream: AudioStream = { sampleRate, channels, close, disposeAsync: close, isOpen: () => !closed };
    return ok(stream);
  }

  renderFrames(frames: number, pos?: Pos): number[] {
    if (!this.active || !this.active.isOpen()) trap("T006", "FakeAudio.renderFrames: no open audio stream", pos);
    if (!Number.isInteger(frames) || frames <= 0) return [];
    const out = new Float32Array(frames * this.active.channels);
    this.active.render(out, frames);
    return Array.from(out);
  }
}

interface FakeSession {
  readonly mainPort: Port;
  readonly workerPort: Port;
  readonly workerDone: () => boolean;
  readonly hasInFlight: () => boolean;
  readonly failDeadlock: () => void;
  readonly close: () => void;
}

/** Deterministic in-process isolate fake using `Port` pack/unpack, trap forwarding, and deadlock detection. */
export class FakeSpawn implements Spawn {
  private readonly sessions = new Set<FakeSession>();
  private deadlockTimer: ReturnType<typeof setTimeout> | undefined;
  static create(): FakeSpawn { return new FakeSpawn(); }

  private clearDeadlockTimer(): void {
    if (this.deadlockTimer !== undefined) {
      clearTimeout(this.deadlockTimer);
      this.deadlockTimer = undefined;
    }
  }

  private scheduleDeadlockCheck(): void {
    this.clearDeadlockTimer();
    if (!this.sessions.size) return;
    this.deadlockTimer = setTimeout(() => {
      this.deadlockTimer = undefined;
      if (!this.sessions.size) return;
      for (const s of this.sessions) if (s.hasInFlight()) return;
      let anyMainWaiting = false;
      for (const s of this.sessions) {
        if (!s.workerDone() && !s.workerPort.waiting) return;
        if (s.mainPort.waiting) anyMainWaiting = true;
      }
      if (!anyMainWaiting) return;
      for (const s of [...this.sessions]) {
        if (s.mainPort.waiting) s.failDeadlock();
      }
    }, 0);
  }

  isolate(_path: string, _name: string, fn: (port: Port, alloc: Alloc) => unknown): Port {
    let closedMain = false;
    let closedWorker = false;
    let workerFinished = false;
    let inFlight = 0;
    let onMainMsg: ((m: Envelope) => void) | undefined;
    let onWorkerMsg: ((m: Envelope) => void) | undefined;
    let onMainClose: (() => void) | undefined;
    let onWorkerClose: (() => void) | undefined;

    const mainCh: Channel = {
      post: (msg) => {
        if (closedMain || closedWorker) return;
        inFlight++;
        this.clearDeadlockTimer();
        queueMicrotask(() => {
          inFlight--;
          if (!closedWorker) onWorkerMsg?.(msg);
          this.scheduleDeadlockCheck();
        });
      },
      onMessage: (f) => { onMainMsg = f; },
      onClose: (f) => { onMainClose = f; },
      close: () => { closedMain = true; this.scheduleDeadlockCheck(); },
      onWait: () => { this.scheduleDeadlockCheck(); },
    };
    const workerCh: Channel = {
      post: (msg) => {
        if (closedWorker) return;
        if (closedMain && !("t" in msg)) return;
        inFlight++;
        this.clearDeadlockTimer();
        queueMicrotask(() => {
          inFlight--;
          onMainMsg?.(msg);
          this.scheduleDeadlockCheck();
        });
      },
      onMessage: (f) => { onWorkerMsg = f; },
      onClose: (f) => { onWorkerClose = f; },
      close: () => { closedWorker = true; this.scheduleDeadlockCheck(); },
      onWait: () => { this.scheduleDeadlockCheck(); },
    };

    const mainPort = new Port(mainCh);
    const workerPort = new Port(workerCh);
    let unregister = (): void => {};

    const forceClose = (): void => {
      if (closedMain && closedWorker && workerFinished) return;
      closedMain = true;
      closedWorker = true;
      workerFinished = true;
      this.sessions.delete(session);
      unregister();
      if (!this.sessions.size) this.clearDeadlockTimer();
      onMainClose?.();
      onWorkerClose?.();
    };

    const session: FakeSession = {
      mainPort,
      workerPort,
      workerDone: () => workerFinished,
      hasInFlight: () => inFlight > 0,
      failDeadlock: () => {
        const msg = "FakeSpawn deadlock: both sides waiting on Port.recv()";
        onMainMsg?.({ t: { code: "T006", message: msg } });
        forceClose();
      },
      close: forceClose,
    };

    this.sessions.add(session);
    unregister = registerFakeIsolate(forceClose);

    queueMicrotask(() => {
      void (async () => {
        try {
          await fn(workerPort, ALLOC);
        } catch (e) {
          if (e instanceof Error && e.name === "StepLimitReached") {
            forceClose();
            throw e;
          }
          const t = asTrap(e);
          const ft: ForeignTrap = t
            ? { code: t.code, ...(t.pos ? { file: t.pos.file, line: t.pos.line, col: t.pos.col } : {}), message: t.message }
            : { code: "T006", message: String(e) };
          if (!closedWorker) workerCh.post({ t: ft });
          else noteIsolateTrap(ft);
        } finally {
          workerFinished = true;
          this.sessions.delete(session);
          unregister();
          if (!closedWorker) workerPort.close();
          if (!closedMain) {
            queueMicrotask(() => {
              if (!closedMain) onMainClose?.();
              this.scheduleDeadlockCheck();
            });
          } else if (!this.sessions.size) {
            this.clearDeadlockTimer();
          }
        }
      })();
    });

    return mainPort;
  }
}

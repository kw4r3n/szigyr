import { Slice, err, ok } from "../../runtime-js/src/index.ts";
import { ALLOC, type Alloc, type Audio, type AudioCallbackSpec, type AudioConfig, type AudioStream, type Clock, type Fs, type Log, type Random } from "./types.ts";

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

export class FakeFs implements Fs {
  private readonly files = new Map<string, string>();
  static create(): FakeFs { return new FakeFs(); }
  readText(path: string) {
    const t = this.files.get(path);
    return t === undefined ? err({ code: "ENOENT", message: `no such file: ${path}` }) : ok(t);
  }
  writeText(path: string, text: string) { this.files.set(path, text); return ok(null); }
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
    const cInit = cb.native?.[`sts_audio_fake_init_${cb.id}`] as ((s: unknown) => unknown) | undefined;
    const cRender = cb.native?.[`sts_audio_fake_render_${cb.id}`] as ((ctx: unknown, out: Float32Array, frames: number) => void) | undefined;
    const cFree = cb.native?.[`sts_audio_fake_free_${cb.id}`] as ((ctx: unknown) => void) | undefined;
    const wasmMod = !cInit ? (cb.native?.[`sts_audio_${cb.id}`] as { init(s: unknown): number; render(b: number, out: Float32Array, f: number): void; free(b: number): void } | undefined) : undefined;
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

  renderFrames(frames: number): number[] {
    if (!this.active || !this.active.isOpen() || !Number.isInteger(frames) || frames <= 0) return [];
    const out = new Float32Array(frames * this.active.channels);
    this.active.render(out, frames);
    return Array.from(out);
  }
}

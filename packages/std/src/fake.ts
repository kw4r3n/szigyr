import { err, ok } from "../../runtime-js/src/index.ts";
import type { Alloc, Clock, Fs, Log, Random } from "./types.ts";
import { ALLOC } from "./node.ts";

export class FakeClock implements Clock {
  private constructor(private ms: number) {}
  static create(startMs: number): FakeClock { return new FakeClock(startMs); }
  nowMs(): number { return this.ms; }
  advance(ms: number): void { this.ms += ms; }
}

/** mulberry32 (D020). Output is a function of the seed only. */
export class SeededRandom implements Random {
  private constructor(private state: number) {}
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

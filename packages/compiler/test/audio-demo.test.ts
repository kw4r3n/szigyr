// Stage 3-8: the audio demo (examples/audio) end to end. The demo is a C-only
// program, so it runs on the C backend with SDL's disk audio driver: the driver
// writes the raw device stream (F32LE stereo, 48000 Hz, no header) to a file
// instead of a sound device, and this test inspects that file. The demo plays
// three sine segments (440 / 660 / 880 Hz) whose parameters are pushed from
// managed code through the ring into the rt callback, so the file's contents
// also prove the parameter path. Without SDL3 the test skips, never fails
// (the same rule as the conformance harness for C libraries).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/index.ts";

function hasSdl3(): boolean {
  try {
    execFileSync("pkg-config", ["--exists", "sdl3"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const RATE = 48000;
const entry = join(import.meta.dirname, "../../../examples/audio/main.szigyr");

// Dominant frequency of one channel over a frame range, by zero crossings.
function estimateFreq(left: Float32Array, from: number, to: number): number {
  let crossings = 0;
  for (let i = from + 1; i < to; i += 1) {
    if ((left[i - 1]! < 0) !== (left[i]! < 0)) crossings += 1;
  }
  return (crossings * RATE) / (2 * (to - from));
}

describe.skipIf(!hasSdl3())("audio demo (examples/audio)", () => {
  it("plays three sine segments whose parameters arrive over the ring", async () => {
    const dir = mkdtempSync(join(tmpdir(), "szigyr-audio-"));
    const file = join(dir, "out.raw");
    process.env.SDL_AUDIO_DRIVER = "disk";
    process.env.SDL_AUDIO_DISK_OUTPUT_FILE = file;
    let r;
    try {
      r = await run(entry, { backend: "c" });
    } finally {
      delete process.env.SDL_AUDIO_DRIVER;
      delete process.env.SDL_AUDIO_DISK_OUTPUT_FILE;
    }
    expect(r.diagnostics).toEqual([]);
    expect(r.trap).toBeNull();

    const data = readFileSync(file);
    expect(data.length % 8).toBe(0); // whole stereo F32 frames only
    const frames = data.length / 8;
    // The demo runs about 0.9 s of audio; startup and teardown trim some.
    expect(frames).toBeGreaterThan(RATE * 0.6);
    expect(frames).toBeLessThan(RATE * 1.5);

    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    let peak = 0;
    for (let i = 0; i < frames; i += 1) {
      const l = data.readFloatLE(i * 8);
      const r = data.readFloatLE(i * 8 + 4);
      left[i] = l;
      right[i] = r;
      const a = Math.abs(l);
      if (a > peak) peak = a;
      expect(a).toBeLessThanOrEqual(0.5 + 1e-6); // the gain, never above
      expect(Math.abs(r - l)).toBeLessThanOrEqual(1e-6);
    }
    expect(peak).toBeGreaterThan(0.45); // the sine reaches (near) its gain

    const third = Math.floor(frames / 3);
    const freqs = [0, 1, 2].map((k) => estimateFreq(left, k * third + Math.floor(third * 0.2), k * third + Math.floor(third * 0.8)));
    const want = [440, 660, 880];
    for (let k = 0; k < 3; k += 1) {
      const f = freqs[k]!;
      const w = want[k]!;
      expect(Math.abs(f - w)).toBeLessThan(w * 0.12);
    }
  }, 120000);
});

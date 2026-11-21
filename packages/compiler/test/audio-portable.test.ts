// Stage 5 Milestone 2 tests: Clock.sleep, Audio capability, FakeAudio across js/c/wasm,
// E2013/E3001/E4001/E6002/sts mutate, and SDL3 disk-driver end-to-end verification (js/c/wasm).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { check, mutate, run, runTestFile, type Backend } from "../src/index.ts";

function hasSdl3(): boolean {
  try {
    execFileSync("pkg-config", ["--exists", "sdl3"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const RATE = 48000;
const portableEntry = join(import.meta.dirname, "../../../examples/audio-portable/main.szigyr");
const tmpFile = (name: string, src: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "sts-audio-p-"));
  const p = join(dir, name);
  writeFileSync(p, src);
  return p;
};

function estimateFreq(left: Float32Array, from: number, to: number): number {
  let crossings = 0;
  for (let i = from + 1; i < to; i += 1) {
    if ((left[i - 1]! < 0) !== (left[i]! < 0)) crossings += 1;
  }
  return (crossings * RATE) / (2 * (to - from));
}

describe("Audio & Clock.sleep frontend, FakeAudio 3-backend parity & mutate", () => {
  it("FakeAudio + Ring + DetMath + Copy state are bit-identical across js, c, and wasm, including trap catching", async () => {
    const p = tmpFile("fake-parity.szigyr", `
type Cmd = Struct<{ readonly freq: f64; readonly gain: f64 }>;
type State = Struct<{ rx: RingRx<Cmd>; phase: f64; freq: f64; gain: f64 }>;

function synth(st: Mut<State>, out: Mut<Slice<f32>>, frames: usize): void {
  "use rt";
  let c = st.rx.pop();
  while (c !== null) {
    st.freq = c.freq;
    st.gain = c.gain;
    c = st.rx.pop();
  }
  for (let i: usize = 0; i < frames; i += 1) {
    const s = f32(st.gain * DetMath.sin(6.283185307179586 * st.phase));
    out[i * 2] = s;
    out[i * 2 + 1] = s;
    st.phase = st.phase + st.freq / 48000;
  }
}

function copySynth(amp: f32, out: Mut<Slice<f32>>, frames: usize): void {
  "use rt";
  for (let i: usize = 0; i < frames; i += 1) {
    out[i] = f32(amp * f32(i + 1));
  }
}

function badOob(x: f64, out: Mut<Slice<f32>>, frames: usize): void {
  "use rt";
  out[frames] = f32(x);
}

test("owned struct + ring deterministic render", async (t: Test) => {
  const { tx, rx } = Ring.create<Cmd>(TestAlloc.create(), 16);
  tx.push({ freq: 1000, gain: 0.5 });
  const fa = FakeAudio.create();
  const st: State = { rx, phase: 0, freq: 0, gain: 0 };
  const r = await fa.open({ sampleRate: 48000, channels: 2 }, st, synth);
  t.ok(r.kind === "ok");
  if (r.kind === "ok") {
    const b1 = fa.renderFrames(4);
    tx.push({ freq: 2000, gain: 0.25 });
    const b2 = fa.renderFrames(4);
    t.eq(b1.length, 8);
    t.eq(b2.length, 8);
    t.eq(b1[0], b1[1]);
    t.eq(b1[2] > 0, true);
    t.eq(b2[0] !== b2[2], true);
    await r.value.close();
  }
});

test("copy state render & oob trap isolation", async (t: Test) => {
  const fa = FakeAudio.create();
  const r = await fa.open({ sampleRate: 48000, channels: 1 }, f32(0.5), copySynth);
  t.ok(r.kind === "ok");
  if (r.kind === "ok") {
    const xs = fa.renderFrames(3);
    t.eq(xs, [f32(0.5), f32(1.0), f32(1.5)]);
    await r.value.close();
  }
  const r2 = await fa.open({ sampleRate: 48000, channels: 1 }, 1.0, badOob);
  t.ok(r2.kind === "ok");
  if (r2.kind === "ok") {
    t.traps("T002", () => {
      fa.renderFrames(4);
    });
    await r2.value.close();
  }
});
`);
    for (const backend of ["js", "c", "wasm"] as const satisfies readonly Backend[]) {
      const res = await runTestFile(p, { backend });
      expect(res.diagnostics, backend).toEqual([]);
      expect(res.results.map((x) => [x.name, x.ok]), backend).toEqual([
        ["owned struct + ring deterministic render", true],
        ["copy state render & oob trap isolation", true],
      ]);
    }
  });

  it("rejects E2013, E3001 move-after-open, E4001 layer misuse, and E6002 contract calls", () => {
    const cases: [string, string, string][] = [
      ["arrow-cb", "E2013", `function m(sys: System): Promise<void> { return (async () => { const _ = await sys.audio.open({ sampleRate: 48000, channels: 1 }, 1.0, (st: f64, out: Mut<Slice<f32>>, f: usize): void => {}); })(); }`],
      ["wrong-sig", "E2013", `function cb(st: i32, out: Mut<Slice<f32>>, f: usize): void { "use rt"; }\nexport async function main(sys: System): Promise<void> { const _ = await sys.audio.open({ sampleRate: 48000, channels: 1 }, 1.0, cb); }`],
      ["string-state", "E2013", `function cb(st: f64, out: Mut<Slice<f32>>, f: usize): void { "use rt"; }\nexport async function main(sys: System): Promise<void> { const _ = await sys.audio.open({ sampleRate: 48000, channels: 1 }, "no", cb); }`],
      ["ptr-in-ring", "E2013", `function cb(st: RingRx<Ptr<u8>>, out: Mut<Slice<f32>>, f: usize): void { "use rt"; "use unsafe"; }\nexport async function main(sys: System): Promise<void> { const { rx } = Ring.create<Ptr<u8>>(sys.alloc, 4); const _ = await sys.audio.open({ sampleRate: 48000, channels: 1 }, rx, cb); }`],
      ["move-state", "E3001", `type S = Struct<{ p: f64 }>;\nfunction cb(st: Mut<S>, out: Mut<Slice<f32>>, f: usize): void { "use rt"; }\nexport async function main(sys: System): Promise<void> { const s: S = { p: 0 }; const _ = await sys.audio.open({ sampleRate: 48000, channels: 1 }, s, cb); sys.log.info(\`\${s.p}\`); }`],
      ["move-vec-state", "E3001", `function cb(st: Mut<Vec<f32>>, out: Mut<Slice<f32>>, f: usize): void { "use rt"; }\nexport async function main(sys: System): Promise<void> { const v = Vec.create<f32>(sys.alloc, 4); const _ = await sys.audio.open({ sampleRate: 48000, channels: 1 }, v, cb); sys.log.info(\`\${v.length}\`); }`],
      ["arenabuf-state", "E2013", `function cb(st: ArenaBuf<f32>, out: Mut<Slice<f32>>, f: usize): void { "use rt"; }\nexport async function main(sys: System): Promise<void> { const a = Arena.create(sys.alloc, 64); const b = a.alloc<f32>(2, f32(0)); if (b !== null) { const _ = await sys.audio.open({ sampleRate: 48000, channels: 1 }, b, cb); } }`],
      ["sleep-strict", "E4001", `function bad(c: Clock): void { "use owned"; const p = c.sleep(1); }`],
      ["open-strict", "E4001", `function cb(x: f64, out: Mut<Slice<f32>>, f: usize): void { "use rt"; }\nfunction bad(a: Audio): void { "use owned"; const p = a.open({ sampleRate: 48000, channels: 1 }, 1.0, cb); }`],
      ["contract-sleep", "E6002", `function bad(c: Clock): boolean { requires(c.sleep(1) !== null); return true; }`],
      ["contract-open", "E6002", `function cb(x: f64, out: Mut<Slice<f32>>, f: usize): void { "use rt"; }\nfunction bad(a: Audio): boolean { requires(a.open({ sampleRate: 48000, channels: 1 }, 1.0, cb) !== null); return true; }`],
    ];
    for (const [name, code, src] of cases) {
      const ds = check(tmpFile(`${name}.szigyr`, src));
      expect(ds.map((d) => d.code), name).toContain(code);
    }
  });

  it("sts mutate works on tests using FakeAudio and rt callback", async () => {
    const p = tmpFile("mutate-audio.szigyr", `
type St = Struct<{ buf: Vec<f32>; rx: RingRx<f32>; gain: f32 }>;
function gainStep(st: Mut<St>, out: Mut<Slice<f32>>, frames: usize): void {
  "use rt";
  let g = st.rx.pop();
  while (g !== null) {
    st.gain = g;
    g = st.rx.pop();
  }
  for (let i: usize = 0; i < frames; i += 1) {
    out[i] = f32(st.buf[0] + st.gain);
  }
}

test("fake audio kill", async (t: Test) => {
  const fa = FakeAudio.create();
  const { tx, rx } = Ring.create<f32>(TestAlloc.create(), 4);
  tx.push(f32(1));
  const buf = Vec.create<f32>(TestAlloc.create(), 1);
  buf.push(f32(2));
  const st: St = { buf, rx, gain: f32(0) };
  const r = await fa.open({ sampleRate: 48000, channels: 1 }, st, gainStep);
  t.ok(r.kind === "ok");
  if (r.kind === "ok") {
    const xs = fa.renderFrames(2);
    t.eq(xs[0], f32(3));
    await r.value.close();
  }
});
`);
    const mr = await mutate(p, { cache: false });
    expect(mr.diagnostics).toEqual([]);
    expect(mr.mutants.some((m) => m.fn === "gainStep" && m.status === "killed")).toBe(true);
  });
});

describe.skipIf(!hasSdl3())("portable audio demo & traps with SDL3 disk driver", () => {
  for (const backend of ["c", "wasm", "js"] as const satisfies readonly Backend[]) {
    it(`plays 440 / 660 / 880 Hz stereo segments on ${backend} backend`, async () => {
      const dir = mkdtempSync(join(tmpdir(), `sts-audio-${backend}-`));
      const file = join(dir, "out.raw");
      process.env.SDL_AUDIO_DRIVER = "disk";
      process.env.SDL_AUDIO_DISK_OUTPUT_FILE = file;
      let r;
      try {
        r = await run(portableEntry, { backend });
      } finally {
        delete process.env.SDL_AUDIO_DRIVER;
        delete process.env.SDL_AUDIO_DISK_OUTPUT_FILE;
      }
      expect(r.diagnostics).toEqual([]);
      expect(r.trap).toBeNull();

      const data = readFileSync(file);
      expect(data.length % 8).toBe(0);
      const frames = data.length / 8;
      expect(frames).toBeGreaterThan(RATE * 0.6);
      expect(frames).toBeLessThan(RATE * 1.5);

      const left = new Float32Array(frames);
      let peak = 0;
      for (let i = 0; i < frames; i += 1) {
        const l = data.readFloatLE(i * 8);
        const rr = data.readFloatLE(i * 8 + 4);
        left[i] = l;
        const a = Math.abs(l);
        if (a > peak) peak = a;
        expect(a).toBeLessThanOrEqual(0.5 + 1e-6);
        expect(Math.abs(rr - l)).toBeLessThanOrEqual(1e-6);
      }
      expect(peak).toBeGreaterThan(0.45);

      // Inspect the interior 20%..80% of each 1/3rd segment so startup/ring/buffer edges never skew zero crossings.
      const third = Math.floor(frames / 3);
      const want = [440, 660, 880];
      for (let k = 0; k < 3; k += 1) {
        const s0 = k * third + Math.floor(third * 0.2);
        const s1 = k * third + Math.floor(third * 0.8);
        const f = estimateFreq(left, s0, s1);
        const w = want[k]!;
        expect(Math.abs(f - w), `${backend} seg ${k}`).toBeLessThan(w * 0.12);
      }
    }, 120000);

    it(`surfaces callback traps and silences output on ${backend} backend`, async () => {
      const p = tmpFile(`trap-${backend}.szigyr`, `
type St = Struct<{ count: i32 }>;
function renderTrap(st: Mut<St>, out: Mut<Slice<f32>>, frames: usize): void {
  "use rt";
  if (st.count >= 1) {
    out[frames] = f32(1);
  }
  st.count += 1;
}
export async function main(sys: System): Promise<void> {
  const s: St = { count: 0 };
  const opened = await sys.audio.open({ sampleRate: 48000, channels: 1 }, s, renderTrap);
  if (opened.kind === "err") return;
  await sys.clock.sleep(150);
  await opened.value.close();
}
`);
      const dir = mkdtempSync(join(tmpdir(), `sts-audio-trap-${backend}-`));
      const file = join(dir, "trap.raw");
      process.env.SDL_AUDIO_DRIVER = "disk";
      process.env.SDL_AUDIO_DISK_OUTPUT_FILE = file;
      let r;
      try {
        r = await run(p, { backend });
      } finally {
        delete process.env.SDL_AUDIO_DRIVER;
        delete process.env.SDL_AUDIO_DISK_OUTPUT_FILE;
      }
      expect(r.diagnostics).toEqual([]);
      expect(r.trap).not.toBeNull();
      expect(r.trap!.code).toBe("T002");
      expect(r.trap!.line).toBe(6);
    }, 60000);
  }

  it("auto-closes unclosed AudioStream cleanly when main exits", async () => {
    const p = tmpFile("autoclose.szigyr", `
function quiet(x: f64, out: Mut<Slice<f32>>, frames: usize): void {
  "use rt";
  for (let i: usize = 0; i < frames; i += 1) {
    out[i] = f32(0.1 * x);
  }
}
export async function main(sys: System): Promise<void> {
  const r = await sys.audio.open({ sampleRate: 48000, channels: 1 }, 1.0, quiet);
  if (r.kind === "ok") {
    await sys.clock.sleep(60);
  }
}
`);
    const dir = mkdtempSync(join(tmpdir(), "sts-audio-ac-"));
    process.env.SDL_AUDIO_DRIVER = "disk";
    process.env.SDL_AUDIO_DISK_OUTPUT_FILE = join(dir, "ac.raw");
    let r;
    try {
      r = await run(p, { backend: "c" });
    } finally {
      delete process.env.SDL_AUDIO_DRIVER;
      delete process.env.SDL_AUDIO_DISK_OUTPUT_FILE;
    }
    expect(r.diagnostics).toEqual([]);
    expect(r.trap).toBeNull();
  }, 60000);
});

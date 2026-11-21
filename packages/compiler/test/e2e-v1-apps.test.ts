import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { main as cliMain } from "../src/cli.ts";
import { run, runTestFile, type Backend } from "../src/index.ts";

const RATE = 48000;
const tmpRoots: string[] = [];
const prevPkgPath = process.env.PKG_CONFIG_PATH;

function makeTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

function hasSdl3(): boolean {
  try {
    execFileSync("pkg-config", ["--exists", "sdl3"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function findPlaywright(): { launch: (opts?: Record<string, unknown>) => Promise<any> } | null {
  try {
    const req = createRequire(import.meta.url);
    const pw = (() => {
      try {
        return req("playwright");
      } catch {
        const bin = execFileSync("which", ["playwright"], { encoding: "utf8" }).trim();
        return createRequire(bin)(resolve(dirname(bin), "..", "playwright"));
      }
    })();
    let executablePath: string | undefined;
    try {
      const def = pw.chromium.executablePath();
      if (!existsSync(def)) {
        const cache = join(homedir(), ".cache/ms-playwright");
        if (existsSync(cache)) {
          const dir = readdirSync(cache).filter((d) => d.startsWith("chromium-")).sort().at(-1);
          if (dir) {
            executablePath = [
              join(cache, dir, "chrome-linux64/chrome"),
              join(cache, dir, "chrome-linux/chrome"),
            ].find((p) => existsSync(p));
          }
        }
      } else {
        executablePath = def;
      }
    } catch {
      /* fallback */
    }
    if (!executablePath) return null;
    return { launch: (opts) => pw.chromium.launch({ executablePath, ...opts }) };
  } catch {
    return null;
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".wasm": "application/wasm",
};

const CAPTURE_WORKLET_JS = `
class CaptureWorklet extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    if (inp && inp.length >= 2 && inp[0].length > 0) {
      const n = inp[0].length;
      const inter = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) { inter[i * 2] = inp[0][i]; inter[i * 2 + 1] = inp[1][i]; }
      this.port.postMessage(inter, [inter.buffer]);
      for (let ch = 0; ch < out.length; ch++) if (inp[ch]) out[ch].set(inp[ch]);
    }
    return true;
  }
}
registerProcessor("capture-worklet", CaptureWorklet);
`;

async function serveDir(dir: string, coi: boolean): Promise<{ url: string; close: () => Promise<void> }> {
  const srv: Server = createServer((req, res) => {
    const u = (req.url ?? "/").split("?")[0]!;
    if (coi) {
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    }
    if (u === "/capture-worklet.js") {
      res.writeHead(200, { "content-type": MIME[".js"]! });
      res.end(CAPTURE_WORKLET_JS);
      return;
    }
    const rel = u === "/" ? "index.html" : u.replace(/^\/+/, "");
    const abs = resolve(dir, rel);
    if (!abs.startsWith(resolve(dir)) || !existsSync(abs)) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[extname(abs)] ?? "application/octet-stream" });
    res.end(readFileSync(abs));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const addr = srv.address() as { port: number };
  return { url: `http://127.0.0.1:${addr.port}`, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

function estimateFreq(left: Float32Array, from: number, to: number): number {
  let crossings = 0;
  for (let i = from + 1; i < to; i += 1) {
    if ((left[i - 1]! < 0) !== (left[i]! < 0)) crossings += 1;
  }
  return (crossings * RATE) / (2 * (to - from));
}

async function runCli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "", err = "";
  const code = await cliMain(argv, (s) => { out += s; }, (s) => { err += s; });
  return { code, out, err };
}

function jsonLines(text: string): Record<string, any>[] {
  return text.trim().split(/\n+/).filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);
}

afterAll(() => {
  if (prevPkgPath === undefined) delete process.env.PKG_CONFIG_PATH;
  else process.env.PKG_CONFIG_PATH = prevPkgPath;
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

// ============================================================================
// App A: Portable Real-Time DSP Audio Effect (dsp.szigyr + main.szigyr + snapshot.szigyr)
// ============================================================================
const appADir = makeTmp("szigyr-e2e-appA-");
const dspPath = join(appADir, "dsp.szigyr");
const appAMainPath = join(appADir, "main.szigyr");
const appASnapPath = join(appADir, "snapshot.szigyr");

writeFileSync(dspPath, `export type EffectCmd = Struct<{ readonly freq: f64; readonly drive: f64; readonly mix: f64 }>;

export type DelayState = Struct<{
  buf: Vec<f32>;
  idx: usize;
  phase: f64;
  freq: f64;
  drive: f64;
  mix: f64;
  rx: RingRx<EffectCmd>;
}>;

export function clampMix(x: f64): f64 {
  "use rt";
  requires(x - x === 0);
  ensures((r: f64) => r >= 0 && r <= 1);
  if (x < 0) {
    return 0;
  }
  if (x > 1) {
    return 1;
  }
  return x;
}

export function pushAll<T extends Native & Copy & Send>(tx: Mut<RingTx<T>>, src: Ref<Slice<T>>): usize {
  "use rt";
  let pushed: usize = 0;
  let i: usize = 0;
  while (i < src.length) {
    if (tx.push(src[i])) {
      pushed += 1;
    }
    i += 1;
  }
  return pushed;
}

export function initDelayLine(alloc: Alloc, len: usize): Vec<f32> {
  "use owned";
  const buf = Vec.create<f32>(alloc, len);
  let i: usize = 0;
  while (i < len) {
    invariant(buf.length <= len && i === buf.length);
    buf.push(f32(0));
    i += 1;
  }
  return buf;
}

export function renderEffect(st: Mut<DelayState>, out: Mut<Slice<f32>>, frames: usize): void {
  "use rt";
  if (st.buf.length === 0) {
    return;
  }
  let cmd = st.rx.pop();
  while (cmd !== null) {
    st.freq = cmd.freq;
    st.drive = cmd.drive;
    st.mix = clampMix(cmd.mix);
    cmd = st.rx.pop();
  }
  let i: usize = 0;
  while (i < frames) {
    const dry = DetMath.sin(6.283185307179586 * st.phase);
    const delayed = f64(st.buf[st.idx]);
    const wet = DetMath.tanh(st.drive * (dry + st.mix * delayed));
    const sample = f32(0.4 * ((1 - st.mix) * dry + st.mix * wet));
    st.buf[st.idx] = f32(wet);
    st.idx = (st.idx + 1) === st.buf.length ? 0 : st.idx + 1;
    out[i * 2] = sample;
    out[i * 2 + 1] = sample;
    st.phase = st.phase + st.freq / 48000;
    if (st.phase >= 1) {
      st.phase = st.phase - 1;
    }
    i += 1;
  }
}

test("clampMix property and boundary cases", (t: Test) => {
  forAll((x: f64): boolean => {
    requires(Number.isFinite(x));
    const y = clampMix(x);
    return y >= 0 && y <= 1;
  });
  t.eq(clampMix(-0.5), 0);
  t.eq(clampMix(0.25), 0.25);
  t.eq(clampMix(1.75), 1);
  t.eq(clampMix(0), 0);
  t.eq(clampMix(1), 1);
});

test("pushAll transfers slice into ring and initDelayLine zero-initializes", (t: Test) => {
  const a = TestAlloc.create();
  const { tx, rx } = Ring.create<EffectCmd>(a, 8);
  const v = Vec.create<EffectCmd>(a, 2);
  v.push({ freq: 440, drive: 1.0, mix: 0.25 });
  v.push({ freq: 880, drive: 1.5, mix: 0.75 });
  const n = pushAll(tx, v);
  t.eq(n, usize(2));
  const c1 = rx.pop();
  const c2 = rx.pop();
  t.ok(c1 !== null && c1.freq === 440);
  t.ok(c2 !== null && c2.freq === 880 && clampMix(c2.mix) === 0.75);
  t.eq(rx.pop(), null);

  const d = initDelayLine(a, 8);
  t.eq(d.length, usize(8));
  t.eq(d[0], f32(0));
  t.eq(d[7], f32(0));
});

test("FakeAudio delay feedback + await using auto-close", async (t: Test) => {
  const a = TestAlloc.create();
  const fa = FakeAudio.create();
  const { tx, rx } = Ring.create<EffectCmd>(a, 8);
  tx.push({ freq: 1200, drive: 1.4, mix: 0.5 });
  const st: DelayState = {
    buf: initDelayLine(a, 8),
    idx: 0,
    phase: 0,
    freq: 440,
    drive: 1.0,
    mix: 0.5,
    rx,
  };
  const opened = await fa.open({ sampleRate: 48000, channels: 2 }, st, renderEffect);
  t.ok(opened.kind === "ok");
  if (opened.kind === "ok") {
    {
      await using stream = opened.value;
      t.eq(stream.isOpen(), true);
      const b1 = fa.renderFrames(8);
      const b2 = fa.renderFrames(8);
      t.eq(b1.length, usize(16));
      t.eq(b2.length, usize(16));
      t.eq(b1[0], b1[1]);
      t.eq(b1[2], b1[3]);
      t.ok(b1[2] > f32(0));
      t.ok(b2[0] !== b1[0]);
      tx.push({ freq: 2400, drive: 1.8, mix: 0.8 });
      const b3 = fa.renderFrames(4);
      t.eq(b3.length, usize(8));
      t.ok(b3[2] !== b2[2]);
    }
    t.traps("T006", () => {
      fa.renderFrames(1);
    });
  }
});
`);

writeFileSync(appAMainPath, `import {
  EffectCmd, DelayState, pushAll, initDelayLine, renderEffect,
} from "./dsp.szigyr";

export async function main(sys: System): Promise<void> {
  const { tx, rx } = Ring.create<EffectCmd>(sys.alloc, 16);
  const initCmds = Vec.create<EffectCmd>(sys.alloc, 2);
  initCmds.push({ freq: 440, drive: 1.2, mix: 0.25 });
  const sent = pushAll(tx, initCmds);
  if (sent !== 1) {
    sys.log.error("failed to enqueue init command");
    return;
  }
  const st: DelayState = {
    buf: initDelayLine(sys.alloc, 2400),
    idx: 0,
    phase: 0,
    freq: 440,
    drive: 1.2,
    mix: 0.25,
    rx,
  };
  const opened = await sys.audio.open({ sampleRate: 48000, channels: 2 }, st, renderEffect);
  if (opened.kind === "err") {
    sys.log.error(opened.error.message);
    return;
  }
  await using stream = opened.value;
  await sys.clock.sleep(350);
  tx.push({ freq: 880, drive: 1.2, mix: 0.25 });
  await sys.clock.sleep(350);
  sys.log.info(\`open=\${stream.isOpen()}\`);
}
`);

writeFileSync(appASnapPath, `import { EffectCmd, DelayState, pushAll, initDelayLine, renderEffect } from "./dsp.szigyr";

export async function main(sys: System): Promise<void> {
  const { tx, rx } = Ring.create<EffectCmd>(sys.alloc, 16);
  const cmds = Vec.create<EffectCmd>(sys.alloc, 1);
  cmds.push({ freq: 600, drive: 1.3, mix: 0.4 });
  pushAll(tx, cmds);
  const fa = FakeAudio.create();
  const st: DelayState = {
    buf: initDelayLine(sys.alloc, 8),
    idx: 0,
    phase: 0,
    freq: 600,
    drive: 1.3,
    mix: 0.4,
    rx,
  };
  const opened = await fa.open({ sampleRate: 48000, channels: 2 }, st, renderEffect);
  if (opened.kind === "err") {
    sys.log.error(opened.error.message);
    return;
  }
  await using stream = opened.value;
  const first = fa.renderFrames(32);
  tx.push({ freq: 1200, drive: 1.6, mix: 0.5 });
  const second = fa.renderFrames(32);
  sys.log.info(\`a=\${first[2]},\${first[16]},b=\${second[0]},\${second[16]},open=\${stream.isOpen()}\`);
}
`);

// ============================================================================
// App B: C FFI + Resource.ownWith + Isolate (Owned Struct) + npm: Hybrid Tool
// ============================================================================
const appBDir = makeTmp("szigyr-e2e-appB-");
const cFxDir = makeTmp("szigyr-e2e-cfx-");
process.env.PKG_CONFIG_PATH = prevPkgPath ? `${cFxDir}:${prevPkgPath}` : cFxDir;

writeFileSync(join(cFxDir, "e2epipe.h"), `#ifndef E2EPIPE_H
#define E2EPIPE_H
#include <stddef.h>
#include <stdint.h>

#define PIPE_MAGIC 0x535A4731u
#define PIPE_SCALE 2.5

typedef struct PipeCfg {
  uint32_t magic;
  int32_t bias;
  double scale;
} PipeCfg;

typedef struct PipeCtx PipeCtx;

PipeCtx *pipe_open(const PipeCfg *cfg);
double pipe_apply(const PipeCtx *ctx, double x);
void pipe_close(PipeCtx *ctx);
int32_t pipe_active_count(void);
void *pipe_alloc(size_t n);
void pipe_free(void *p);
#endif
`);

writeFileSync(join(cFxDir, "e2epipe.c"), `#include "e2epipe.h"
#include <stdio.h>
#include <stdlib.h>

struct PipeCtx {
  int32_t bias;
  double scale;
};

static int32_t active_pipes = 0;

static void log_event(const char *ev) {
  const char *path = getenv("E2E_PIPE_LOG");
  if (!path || !*path) return;
  FILE *f = fopen(path, "a");
  if (!f) return;
  fputs(ev, f);
  fputc('\\n', f);
  fclose(f);
}

PipeCtx *pipe_open(const PipeCfg *cfg) {
  if (!cfg || cfg->magic != PIPE_MAGIC) return NULL;
  PipeCtx *c = (PipeCtx *)calloc(1, sizeof *c);
  if (!c) return NULL;
  c->bias = cfg->bias;
  c->scale = cfg->scale;
  active_pipes += 1;
  return c;
}

double pipe_apply(const PipeCtx *ctx, double x) {
  if (!ctx) return 0.0;
  return x * ctx->scale + (double)ctx->bias;
}

void pipe_close(PipeCtx *ctx) {
  if (!ctx) return;
  active_pipes -= 1;
  log_event("close");
  free(ctx);
}

int32_t pipe_active_count(void) {
  return active_pipes;
}

void *pipe_alloc(size_t n) {
  return calloc(1, n > 0 ? n : 1);
}

void pipe_free(void *p) {
  if (!p) return;
  log_event("free");
  free(p);
}
`);

execFileSync(process.env.CC || "cc", [
  "-std=gnu11", "-O2", "-shared", "-fPIC",
  join(cFxDir, "e2epipe.c"),
  "-o", join(cFxDir, "libe2epipe.so"),
]);
writeFileSync(join(cFxDir, "e2epipe.pc"), `prefix=\${pcfiledir}
Name: e2epipe
Description: Szigyr v1 E2E C FFI test fixture
Version: 1.0.0
Cflags: -I\${prefix}
Libs: -L\${prefix} -Wl,-rpath,\${prefix} -le2epipe
`);

const nmDir = join(appBDir, "node_modules", "e2e-fmt");
mkdirSync(nmDir, { recursive: true });
writeFileSync(join(nmDir, "package.json"), JSON.stringify({
  name: "e2e-fmt",
  version: "1.0.0",
  type: "module",
  exports: { ".": "./index.mjs" },
}));
writeFileSync(join(nmDir, "fmt.mjs"), `export function formatReport(tag, val, active) {
  return \`\${tag}:\${val}:active=\${active}\`;
}
`);
writeFileSync(join(nmDir, "index.mjs"), `export * as fmt from "./fmt.mjs";
`);

const modelPath = join(appBDir, "model.szigyr");
const appBMainPath = join(appBDir, "main.szigyr");
const appBTrapPath = join(appBDir, "trap_main.szigyr");

writeFileSync(modelPath, `export interface Labeler {
  label(tag: string): string;
}

export class RunAudit implements Disposable, Labeler {
  private closed: boolean;
  private calls: i32;
  constructor() {
    this.closed = false;
    this.calls = 0;
  }
  label(tag: string): string {
    if (this.closed) {
      return \`closed:\${tag}\`;
    }
    this.calls += 1;
    return \`\${tag}#\${this.calls}\`;
  }
  isClosed(): boolean {
    return this.closed;
  }
  dispose(): void {
    this.closed = true;
  }
}

export type Job = Struct<{ weights: Vec<f64>; values: Vec<f64> }>;

export function weightedSum(job: Ref<Job>): f64 {
  "use owned";
  requires(job.weights.length === job.values.length);
  let acc: f64 = 0;
  let i: usize = 0;
  while (i < job.weights.length) {
    invariant(i <= job.weights.length);
    acc += job.weights[i] * job.values[i];
    i += 1;
  }
  return acc;
}

test("weightedSum and RunAudit Disposable", (t: Test) => {
  const a = TestAlloc.create();
  const ws = Vec.create<f64>(a, 2);
  const vs = Vec.create<f64>(a, 2);
  ws.push(2);
  ws.push(3);
  vs.push(4);
  vs.push(5);
  const job: Job = { weights: ws, values: vs };
  t.eq(weightedSum(job), 23);

  forAll((x: f64, y: f64): boolean => {
    requires(Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) < 1e6 && Math.abs(y) < 1e6);
    const ta = TestAlloc.create();
    const w = Vec.create<f64>(ta, 2);
    const v = Vec.create<f64>(ta, 2);
    w.push(x);
    w.push(1);
    v.push(2);
    v.push(y);
    const j: Job = { weights: w, values: v };
    return weightedSum(j) === x * 2 + y;
  });

  const audit = new RunAudit();
  {
    using scoped = audit;
    t.eq(scoped.isClosed(), false);
    t.eq(scoped.label("ok"), "ok#1");
    t.eq(scoped.label("ok"), "ok#2");
  }
  t.eq(audit.isClosed(), true);
  t.eq(audit.label("late"), "closed:late");
});
`);

writeFileSync(appBMainPath, `declare module "c:e2epipe:e2epipe.h" {
  const PIPE_MAGIC: u32;
  const PIPE_SCALE: f64;
  type PipeCfg = CStruct<{ magic: u32; bias: i32; scale: f64 }>;
  function pipe_open(ffi: Ffi, cfg: ConstPtr<PipeCfg>): Ptr<CType<"PipeCtx">>;
  function pipe_apply(ffi: Ffi, ctx: ConstPtr<CType<"PipeCtx">>, x: f64): f64;
  function pipe_close(ffi: Ffi, ctx: Ptr<CType<"PipeCtx">>): void;
  function pipe_active_count(ffi: Ffi): i32;
  function pipe_alloc(ffi: Ffi, n: usize): Ptr<void>;
  function pipe_free(ffi: Ffi, p: Ptr<void>): void;
}
import {
  PIPE_MAGIC, PIPE_SCALE, PipeCfg, pipe_open, pipe_apply, pipe_close, pipe_active_count, pipe_alloc, pipe_free,
} from "c:e2epipe:e2epipe.h";
import { fmt } from "npm:e2e-fmt";
import { RunAudit, Job, weightedSum } from "./model.szigyr";

function freeMem(ffi: Ffi, p: Ptr<void>): void {
  "use owned";
  "use unsafe";
  pipe_free(ffi, p);
}

function closeCtxPtr(ffi: Ffi, p: Ptr<CType<"PipeCtx">>): void {
  "use owned";
  "use unsafe";
  pipe_close(ffi, p);
}

function closeCtxHandle(ffi: Ffi, h: CHandle<CType<"PipeCtx">>): void {
  "use owned";
  "use unsafe";
  pipe_close(ffi, h.get());
}

export function openPipe(ffi: Ffi, bias: i32): CHandle<CType<"PipeCtx">> {
  "use owned";
  "use unsafe";
  using cfgMem = Resource.ownWith(pipe_alloc(ffi, Ptr.sizeOf<PipeCfg>()), ffi, freeMem);
  if (cfgMem.get().isNull()) {
    panic("cfg alloc failed");
  }
  cfgMem.get().cast<PipeCfg>().write({ magic: PIPE_MAGIC, bias: bias, scale: PIPE_SCALE });
  using ctxGuard = Resource.ownWith(pipe_open(ffi, cfgMem.get().cast<PipeCfg>()), ffi, closeCtxPtr);
  if (ctxGuard.get().isNull()) {
    panic("pipe_open failed");
  }
  return CHandle.create(ctxGuard.take());
}

export function evalWithPipe(ffi: Ffi, bias: i32, x: f64, triggerTrap: boolean): f64 {
  "use owned";
  "use unsafe";
  using h = Resource.ownWith(openPipe(ffi, bias), ffi, closeCtxHandle);
  if (triggerTrap) {
    const z: i32 = 0;
    const dead = divTrunc(1, z);
    return f64(dead);
  }
  return pipe_apply(ffi, h.borrow().get(), x);
}

export function activePipes(ffi: Ffi): i32 {
  "use owned";
  "use unsafe";
  return pipe_active_count(ffi);
}

export function buildJob(alloc: Alloc, w0: f64, w1: f64, v0: f64, v1: f64): Job {
  "use owned";
  const weights = Vec.create<f64>(alloc, 2);
  const values = Vec.create<f64>(alloc, 2);
  weights.push(w0);
  weights.push(w1);
  values.push(v0);
  values.push(v1);
  return { weights, values };
}

async function computeWorker(port: Port<f64, Job>): Promise<void> {
  const job = await port.recv();
  if (job !== null) {
    port.send(weightedSum(job));
  }
}

export async function main(sys: System): Promise<void> {
  using audit = new RunAudit();
  const iso = sys.spawn.isolate<Job, f64>(computeWorker);
  iso.send(buildJob(sys.alloc, 2, 3, 4, 5));
  const sum = await iso.recv();
  iso.close();
  if (sum === null) {
    sys.log.error("isolate closed without result");
    return;
  }
  const out = evalWithPipe(sys.ffi, 3, sum, false);
  const active = activePipes(sys.ffi);
  const fRes = sys.js.get(fmt, "formatReport");
  if (fRes.kind === "err") {
    sys.log.error(fRes.error.message);
    return;
  }
  const callRes = sys.js.call(fRes.value, [
    sys.js.encode<string>(audit.label("ok")),
    sys.js.encode<f64>(out),
    sys.js.encode<i32>(active),
  ]);
  if (callRes.kind === "err") {
    sys.log.error(callRes.error.message);
    return;
  }
  const msg = sys.js.decode<string>(callRes.value);
  if (msg.kind === "err") {
    sys.log.error(msg.error.message);
    return;
  }
  sys.log.info(msg.value);
}

test("buildJob produces weights and values", (t: Test) => {
  const j = buildJob(TestAlloc.create(), 2, 3, 4, 5);
  t.eq(j.weights.length, usize(2));
  t.eq(j.values.length, usize(2));
  t.eq(weightedSum(j), 23);
});
`);

writeFileSync(appBTrapPath, `import { evalWithPipe } from "./main.szigyr";

export function main(sys: System): void {
  const v = evalWithPipe(sys.ffi, 3, 10, true);
  sys.log.info(\`unreachable=\${v}\`);
}
`);

const pw = findPlaywright();

describe("E2E real v1 multi-module app validation", () => {
  describe("App A: Portable Real-Time DSP Audio Effect", () => {
    it("passes check, query, FakeAudio tests & snapshot 3-backend parity (js, c, wasm)", async () => {
      const chk = await runCli(["check", "--json", appAMainPath]);
      expect(chk.code, chk.err + chk.out).toBe(0);
      expect(chk.out).toBe("");

      const q = await runCli(["query", "--json", dspPath]);
      expect(q.code, q.err).toBe(0);
      const syms = jsonLines(q.out);
      expect(syms.find((s) => s.name === "clampMix")).toMatchObject({
        kind: "symbol",
        symbolKind: "function",
        layer: "rt",
        pure: true,
        exported: true,
      });
      expect(syms.find((s) => s.name === "renderEffect")).toMatchObject({
        kind: "symbol",
        symbolKind: "function",
        layer: "rt",
        exported: true,
      });
      const pushSym = syms.find((s) => s.name === "pushAll");
      expect(pushSym).toMatchObject({
        kind: "symbol",
        symbolKind: "function",
        layer: "rt",
        exported: true,
        type: "(Mut<RingTx<T>>, Ref<Slice<T>>) => usize",
      });
      expect(syms.find((s) => s.name === "EffectCmd")?.caps).toEqual(expect.arrayContaining(["Native", "Copy", "Send", "Codec"]));

      for (const backend of ["js", "c", "wasm"] as const satisfies readonly Backend[]) {
        const tr = await runTestFile(dspPath, { backend });
        expect(tr.diagnostics, backend).toEqual([]);
        expect(tr.results.every((r) => r.ok), `${backend}: ${JSON.stringify(tr.results)}`).toBe(true);
      }

      const outs: Record<string, string> = {};
      for (const backend of ["js", "c", "wasm"] as const satisfies readonly Backend[]) {
        const res = await run(appASnapPath, { backend });
        expect(res.diagnostics, backend).toEqual([]);
        expect(res.trap, backend).toBeNull();
        outs[backend] = res.stdout;
      }
      expect(outs.js).toContain("open=true\n");
      expect(outs.c).toBe(outs.js);
      expect(outs.wasm).toBe(outs.js);
    });

    it("kills mutants across clampMix, pushAll, and renderEffect via szigyr mutate", async () => {
      const mr = await runCli(["mutate", "--json", "--no-cache", dspPath]);
      expect(mr.code, mr.err + mr.out).toBe(0);
      const recs = jsonLines(mr.out);
      const summary = recs.find((r) => r.kind === "summary");
      expect(summary).toBeDefined();
      expect(summary!.killed).toBeGreaterThan(0);
      const killed = recs.filter((r) => r.kind === "mutant" && r.status === "killed");
      expect(killed.some((m) => m.fn === "clampMix")).toBe(true);
      expect(killed.some((m) => m.fn === "renderEffect")).toBe(true);
    });

    it.skipIf(!hasSdl3())("builds --target=node, relocates standalone bundle, and renders 440 -> 880 Hz stereo PCM over SDL3 disk driver", async () => {
      const outDir = makeTmp("szigyr-e2e-appA-node-out-");
      const isoDir = makeTmp("szigyr-e2e-appA-node-iso-");
      const rawFile = join(makeTmp("szigyr-e2e-appA-raw-"), "out.raw");

      const br = await runCli(["build", "--target=node", "-o", outDir, appAMainPath]);
      expect(br.code, br.err).toBe(0);
      cpSync(outDir, isoDir, { recursive: true });
      rmSync(outDir, { recursive: true, force: true });

      const stdout = execFileSync(process.execPath, [join(isoDir, "main.js")], {
        env: { ...process.env, SDL_AUDIO_DRIVER: "disk", SDL_AUDIO_DISK_OUTPUT_FILE: rawFile },
        encoding: "utf8",
      });
      expect(stdout).toContain("open=true\n");

      const data = readFileSync(rawFile);
      expect(data.length % 8).toBe(0);
      const frames = data.length / 8;
      expect(frames).toBeGreaterThan(RATE * 0.4);
      expect(frames).toBeLessThan(RATE * 1.5);

      const left = new Float32Array(frames);
      let peak = 0;
      for (let i = 0; i < frames; i += 1) {
        const l = data.readFloatLE(i * 8);
        const rr = data.readFloatLE(i * 8 + 4);
        left[i] = l;
        const a = Math.abs(l);
        if (a > peak) peak = a;
        expect(a).toBeLessThanOrEqual(1.0);
        expect(Math.abs(rr - l)).toBeLessThanOrEqual(1e-6);
      }
      expect(peak).toBeGreaterThan(0.2);

      const half = Math.floor(frames / 2);
      const f1 = estimateFreq(left, Math.floor(half * 0.2), Math.floor(half * 0.8));
      const f2 = estimateFreq(left, half + Math.floor(half * 0.2), half + Math.floor(half * 0.8));
      expect(Math.abs(f1 - 440), `f1=${f1}`).toBeLessThan(440 * 0.12);
      expect(Math.abs(f2 - 880), `f2=${f2}`).toBeLessThan(880 * 0.12);
    }, 60000);

    it.skipIf(!pw)("builds --target=browser and runs Wasm + AudioWorklet in Chromium (COOP/COEP SAB and MessagePort fallback)", async () => {
      const outDir = makeTmp("szigyr-e2e-appA-browser-");
      const br = await runCli(["build", "--target=browser", "-o", outDir, appAMainPath]);
      expect(br.code, br.err).toBe(0);

      for (const rel of ["app.js", "program.js", "szigyr-worker.js", "szigyr-worklet.js"]) {
        expect(readFileSync(join(outDir, rel), "utf8")).not.toMatch(/["']node:/);
      }

      for (const coi of [true, false]) {
        const srv = await serveDir(outDir, coi);
        const browser = await pw!.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
        try {
          const page = await browser.newPage();
          const pageErrors: string[] = [];
          page.on("pageerror", (e: Error) => pageErrors.push(e.message));
          await page.goto(srv.url);
          const res = await page.evaluate(`(async () => {
            const { start } = await import("./app.js");
            const chunks = [];
            const runRes = await start({
              onNode: async (node, ctx) => {
                await ctx.audioWorklet.addModule("/capture-worklet.js");
                const cap = new AudioWorkletNode(ctx, "capture-worklet", {
                  numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: "explicit", outputChannelCount: [2],
                });
                cap.port.onmessage = (ev) => { chunks.push(Array.from(new Float32Array(ev.data))); };
                node.connect(cap);
                cap.connect(ctx.destination);
              },
            });
            let total = 0;
            for (const c of chunks) total += c.length;
            const flat = new Float32Array(total);
            let off = 0;
            for (const c of chunks) { flat.set(c, off); off += c.length; }
            return { isolated: self.crossOriginIsolated, runRes, samples: Array.from(flat) };
          })()`) as { isolated: boolean; runRes: { stdout: string; trap: unknown }; samples: number[] };

          expect(pageErrors).toEqual([]);
          expect(res.isolated).toBe(coi);
          expect(res.runRes.trap).toBeNull();
          expect(res.runRes.stdout).toContain("open=true\n");

          const frames = res.samples.length / 2;
          expect(frames).toBeGreaterThan(RATE * 0.4);
          const left = new Float32Array(frames);
          let peak = 0;
          for (let i = 0; i < frames; i += 1) {
            const l = res.samples[i * 2]!, rr = res.samples[i * 2 + 1]!;
            left[i] = l;
            const a = Math.abs(l);
            if (a > peak) peak = a;
            expect(a).toBeLessThanOrEqual(1.0);
            expect(Math.abs(rr - l)).toBeLessThanOrEqual(1e-6);
          }
          expect(peak).toBeGreaterThan(0.2);

          const half = Math.floor(frames / 2);
          const f1 = estimateFreq(left, Math.floor(half * 0.2), Math.floor(half * 0.8));
          const f2 = estimateFreq(left, half + Math.floor(half * 0.2), half + Math.floor(half * 0.8));
          expect(Math.abs(f1 - 440), `coi=${coi} f1=${f1}`).toBeLessThan(440 * 0.15);
          expect(Math.abs(f2 - 880), `coi=${coi} f2=${f2}`).toBeLessThan(880 * 0.15);
        } finally {
          await browser.close();
          await srv.close();
        }
      }
    }, 60000);
  });

  describe("App B: C FFI + Resource.ownWith + Isolate + npm: Hybrid Tool", () => {
    it("passes P1-P4 check, query, model unit tests across js/c, and mutate", async () => {
      const chk = await runCli(["check", "--json", appBMainPath]);
      expect(chk.code, chk.err + chk.out).toBe(0);
      expect(chk.out).toBe("");

      const q = await runCli(["query", "--json", appBMainPath]);
      expect(q.code, q.err).toBe(0);
      const syms = jsonLines(q.out);
      expect(syms.find((s) => s.name === "PIPE_MAGIC")).toMatchObject({ kind: "symbol", symbolKind: "const", type: "u32", unsafe: true });
      expect(syms.find((s) => s.name === "PipeCfg")).toMatchObject({ kind: "symbol", symbolKind: "type", type: "PipeCfg", unsafe: true });
      expect(syms.find((s) => s.name === "openPipe")).toMatchObject({ kind: "symbol", symbolKind: "function", unsafe: true, exported: true });

      for (const backend of ["js", "c"] as const satisfies readonly Backend[]) {
        const tr = await runTestFile(modelPath, { backend });
        expect(tr.diagnostics, backend).toEqual([]);
        expect(tr.results.every((r) => r.ok), backend).toBe(true);
      }

      const mm = await runCli(["mutate", "--json", "--no-cache", modelPath]);
      expect(mm.code, mm.err).toBe(0);
      const mRecs = jsonLines(mm.out);
      const mKilled = mRecs.filter((r) => r.kind === "mutant" && r.status === "killed");
      expect(mKilled.some((m) => m.fn === "weightedSum")).toBe(true);
      expect(mKilled.some((m) => m.fn === "RunAudit.label")).toBe(true);

      const mb = await runCli(["mutate", "--json", "--no-cache", appBMainPath]);
      expect(mb.code, mb.err).toBe(0);
      const mbRecs = jsonLines(mb.out);
      const mbSummary = mbRecs.find((r) => r.kind === "summary");
      expect(mbSummary?.skipped).toEqual(expect.arrayContaining([{ fn: "openPipe", reason: "unsafe" }, { fn: "evalWithPipe", reason: "unsafe" }]));
    });

    it("executes C FFI + Isolate + npm: via run and relocated standalone build --target=node, including trap-unwind cleanup", async () => {
      const r = await run(appBMainPath, { backend: "c" });
      expect(r.diagnostics).toEqual([]);
      expect(r.trap).toBeNull();
      expect(r.stdout).toBe("ok#1:60.5:active=0\n");

      const outDir = makeTmp("szigyr-e2e-appB-out-");
      const isoDir = makeTmp("szigyr-e2e-appB-iso-");
      const okLog = join(makeTmp("szigyr-e2e-appB-log-"), "events.log");

      const br = await runCli(["build", "--target=node", "-o", outDir, appBMainPath]);
      expect(br.code, br.err).toBe(0);
      cpSync(outDir, isoDir, { recursive: true });
      rmSync(outDir, { recursive: true, force: true });

      const out = execFileSync(process.execPath, [join(isoDir, "main.js")], {
        env: { ...process.env, E2E_PIPE_LOG: okLog },
        encoding: "utf8",
      });
      expect(out).toBe("ok#1:60.5:active=0\n");
      expect(readFileSync(okLog, "utf8").trim().split(/\n+/)).toEqual(["free", "close"]);

      const trapOutDir = makeTmp("szigyr-e2e-appB-trap-");
      const trapLog = join(makeTmp("szigyr-e2e-appB-traplog-"), "trap.log");
      const tb = await runCli(["build", "--target=node", "-o", trapOutDir, appBTrapPath]);
      expect(tb.code, tb.err).toBe(0);
      const child = spawnSync(process.execPath, [join(trapOutDir, "main.js")], {
        env: { ...process.env, E2E_PIPE_LOG: trapLog },
        encoding: "utf8",
      });
      expect(child.status).toBe(3);
      expect(child.stderr).toContain("T007");
      expect(readFileSync(trapLog, "utf8").trim().split(/\n+/)).toEqual(["free", "close"]);
    });
  });
});

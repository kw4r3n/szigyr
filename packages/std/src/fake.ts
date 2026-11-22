import {
  Port, Slice, asTrap, err, noteIsolateTrap, ok, readU8Slice, registerFakeIsolate, replaceU8Vec, trap,
  type Channel, type Envelope, type ForeignTrap, type Pos, type Result, type Vec,
} from "../../runtime-js/src/index.ts";
import {
  ALLOC, type Alloc, type Audio, type AudioCallbackSpec, type AudioConfig, type AudioStream, type Clock, type DirEntry,
  type FileStat, type Fs, type FsEntryKind, type HttpClientRequest, type HttpHeader, type HttpRequestInit, type HttpResponse,
  type HttpServer, type HttpServerConfig, type HttpServerRequest, type HttpServerResponse, type IoError, type Log, type Net,
  type Proc, type ProcOptions, type ProcOutput, type ProcRequest, type Random, type Spawn,
} from "./types.ts";

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

function normFakePath(raw: string): string {
  const abs = raw.startsWith("/");
  const parts: string[] = [];
  for (const seg of raw.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (parts.length && parts.at(-1) !== "..") parts.pop();
      else if (!abs) parts.push("..");
    } else {
      parts.push(seg);
    }
  }
  return abs ? `/${parts.join("/")}` : (parts.join("/") || ".");
}

function parentDirOf(norm: string): string | undefined {
  if (norm === "." || norm === "/") return undefined;
  const i = norm.lastIndexOf("/");
  if (i < 0) return ".";
  return i === 0 ? "/" : norm.slice(0, i);
}

function baseNameOf(norm: string): string {
  if (norm === "." || norm === "/") return norm;
  const i = norm.lastIndexOf("/");
  return i < 0 ? norm : norm.slice(i + 1);
}

function ancestorsOf(norm: string): string[] {
  const out: string[] = [];
  let cur = parentDirOf(norm);
  while (cur && cur !== "." && cur !== "/") {
    out.push(cur);
    cur = parentDirOf(cur);
  }
  out.reverse();
  return out;
}

export class FakeFs implements Fs {
  private readonly files = new Map<string, { data: Uint8Array; mtimeMs: number }>();
  private readonly dirs = new Set<string>([".", "/"]);
  private readonly symlinks = new Map<string, { target: string; mtimeMs: number }>();
  private tick = 0;
  static create(): FakeFs { return new FakeFs(); }

  private resolveLink(norm: string): { kind: "ok"; target: string } | { kind: "loop" } | { kind: "missing" } {
    let cur = norm;
    for (let hop = 0; hop < 16; hop++) {
      const sym = this.symlinks.get(cur);
      if (!sym) return this.files.has(cur) || this.dirs.has(cur) ? { kind: "ok", target: cur } : { kind: "missing" };
      if (sym.target.startsWith("/")) cur = normFakePath(sym.target);
      else {
        const pdir = parentDirOf(cur) ?? ".";
        cur = normFakePath(pdir === "." ? sym.target : `${pdir}/${sym.target}`);
      }
    }
    return { kind: "loop" };
  }

  private resolveReadable(path: string, norm: string): Result<string, IoError> {
    if (!this.symlinks.has(norm)) return ok(norm);
    const r = this.resolveLink(norm);
    if (r.kind === "loop") return err({ code: "ELOOP", message: `too many levels of symbolic links: ${path}` });
    if (r.kind === "missing") return err({ code: "ENOENT", message: `no such file: ${path}` });
    return ok(r.target);
  }

  private checkAncestorsDir(path: string, norm: string): IoError | undefined {
    for (const anc of ancestorsOf(norm)) {
      if (this.files.has(anc) || this.symlinks.has(anc)) return { code: "ENOTDIR", message: `not a directory: ${anc}` };
    }
    const parent = parentDirOf(norm);
    if (parent && !this.dirs.has(parent)) return { code: "ENOENT", message: `no such file or directory: ${path}` };
    return undefined;
  }

  private prepareWrite(path: string): Result<string, IoError> {
    if (!path) return err({ code: "EINVAL", message: "empty path" });
    const norm = normFakePath(path);
    if (this.dirs.has(norm)) return err({ code: "EISDIR", message: `illegal operation on a directory: ${path}` });
    const ancErr = this.checkAncestorsDir(path, norm);
    return ancErr ? err(ancErr) : ok(norm);
  }

  addSymlink(path: string, target: string): Result<null, IoError> {
    if (!path || !target) return err({ code: "EINVAL", message: "empty symlink path or target" });
    const norm = normFakePath(path);
    if (this.files.has(norm) || this.dirs.has(norm) || this.symlinks.has(norm)) {
      return err({ code: "EEXIST", message: `file already exists: ${path}` });
    }
    const ancErr = this.checkAncestorsDir(path, norm);
    if (ancErr) return err(ancErr);
    this.symlinks.set(norm, { target, mtimeMs: ++this.tick });
    return ok(null);
  }

  readText(path: string) {
    if (!path) return err({ code: "EINVAL", message: "empty path" });
    const res = this.resolveReadable(path, normFakePath(path));
    if (res.kind === "err") return res;
    if (this.dirs.has(res.value)) return err({ code: "EISDIR", message: `illegal operation on a directory: ${path}` });
    const f = this.files.get(res.value);
    return f === undefined ? err({ code: "ENOENT", message: `no such file: ${path}` }) : ok(utf8Dec.decode(f.data));
  }

  writeText(path: string, text: string) {
    const p = this.prepareWrite(path);
    if (p.kind === "err") return p;
    this.symlinks.delete(p.value);
    this.files.set(p.value, { data: utf8Enc.encode(text), mtimeMs: ++this.tick });
    return ok(null);
  }

  readBytes(path: string, dst: Vec<number>) {
    if (!path) return err({ code: "EINVAL", message: "empty path" });
    const res = this.resolveReadable(path, normFakePath(path));
    if (res.kind === "err") return res;
    if (this.dirs.has(res.value)) return err({ code: "EISDIR", message: `illegal operation on a directory: ${path}` });
    const f = this.files.get(res.value);
    if (f === undefined) return err({ code: "ENOENT", message: `no such file: ${path}` });
    if (f.data.byteLength > 0xffffffff) return err({ code: "EFBIG", message: "file exceeds usize limit (4GiB)" });
    replaceU8Vec(dst, f.data);
    return ok(f.data.byteLength);
  }

  writeBytes(path: string, data: Slice<number> | Vec<number>) {
    const p = this.prepareWrite(path);
    if (p.kind === "err") return p;
    this.symlinks.delete(p.value);
    this.files.set(p.value, { data: new Uint8Array(readU8Slice(data)), mtimeMs: ++this.tick });
    return ok(null);
  }

  exists(path: string): boolean {
    if (!path) return false;
    const norm = normFakePath(path);
    if (this.symlinks.has(norm)) {
      const r = this.resolveLink(norm);
      return r.kind === "ok";
    }
    return this.files.has(norm) || this.dirs.has(norm);
  }

  stat(path: string): Result<FileStat, IoError> {
    if (!path) return err({ code: "EINVAL", message: "empty path" });
    const norm = normFakePath(path);
    const s = this.symlinks.get(norm);
    if (s) return ok({ kind: "symlink", size: BigInt(utf8Enc.encode(s.target).byteLength), mtimeMs: s.mtimeMs });
    const f = this.files.get(norm);
    if (f) return ok({ kind: "file", size: BigInt(f.data.byteLength), mtimeMs: f.mtimeMs });
    if (this.dirs.has(norm)) return ok({ kind: "dir", size: 0n, mtimeMs: 0 });
    return err({ code: "ENOENT", message: `no such file or directory: ${path}` });
  }

  readDir(path: string): Result<DirEntry[], IoError> {
    if (!path) return err({ code: "EINVAL", message: "empty path" });
    const norm = normFakePath(path);
    if (this.files.has(norm) || this.symlinks.has(norm)) return err({ code: "ENOTDIR", message: `not a directory: ${path}` });
    if (!this.dirs.has(norm)) return err({ code: "ENOENT", message: `no such file or directory: ${path}` });
    const out = new Map<string, FsEntryKind>();
    for (const k of this.files.keys()) {
      if (parentDirOf(k) === norm) out.set(baseNameOf(k), "file");
    }
    for (const d of this.dirs) {
      if (parentDirOf(d) === norm) out.set(baseNameOf(d), "dir");
    }
    for (const s of this.symlinks.keys()) {
      if (parentDirOf(s) === norm) out.set(baseNameOf(s), "symlink");
    }
    const entries: DirEntry[] = [...out.entries()].map(([name, kind]) => ({ name, kind }));
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return ok(entries);
  }

  mkdir(path: string): Result<null, IoError> {
    if (!path) return err({ code: "EINVAL", message: "empty path" });
    const norm = normFakePath(path);
    if (this.files.has(norm) || this.symlinks.has(norm)) return err({ code: "EEXIST", message: `file already exists: ${path}` });
    for (const anc of ancestorsOf(norm)) {
      if (this.files.has(anc) || this.symlinks.has(anc)) return err({ code: "ENOTDIR", message: `not a directory: ${anc}` });
    }
    for (const anc of ancestorsOf(norm)) this.dirs.add(anc);
    this.dirs.add(norm);
    return ok(null);
  }

  remove(path: string): Result<null, IoError> {
    if (!path) return err({ code: "EINVAL", message: "empty path" });
    const norm = normFakePath(path);
    if (norm === "." || norm === "/") return err({ code: "EBUSY", message: `cannot remove root directory: ${path}` });
    if (this.symlinks.delete(norm)) return ok(null);
    if (this.files.delete(norm)) return ok(null);
    if (this.dirs.has(norm)) {
      const prefix = `${norm}/`;
      for (const k of [...this.files.keys()]) if (k.startsWith(prefix)) this.files.delete(k);
      for (const s of [...this.symlinks.keys()]) if (s.startsWith(prefix)) this.symlinks.delete(s);
      for (const d of [...this.dirs]) if (d === norm || d.startsWith(prefix)) this.dirs.delete(d);
      return ok(null);
    }
    return err({ code: "ENOENT", message: `no such file or directory: ${path}` });
  }

  rename(from: string, to: string): Result<null, IoError> {
    if (!from || !to) return err({ code: "EINVAL", message: "empty path" });
    const src = normFakePath(from);
    const dst = normFakePath(to);
    const isFile = this.files.has(src);
    const isDir = this.dirs.has(src);
    const isSym = this.symlinks.has(src);
    if (!isFile && !isDir && !isSym) return err({ code: "ENOENT", message: `no such file or directory: ${from}` });
    if (src === "." || src === "/" || dst === "." || dst === "/") return err({ code: "EBUSY", message: "cannot rename root directory" });
    if (src === dst) return ok(null);
    const dstParent = parentDirOf(dst);
    if (dstParent) {
      if (this.files.has(dstParent) || this.symlinks.has(dstParent)) return err({ code: "ENOTDIR", message: `not a directory: ${dstParent}` });
      if (!this.dirs.has(dstParent)) return err({ code: "ENOENT", message: `no such parent directory: ${dstParent}` });
    }
    if (isSym) {
      if (this.dirs.has(dst)) return err({ code: "EISDIR", message: `is a directory: ${to}` });
      this.files.delete(dst);
      const s = this.symlinks.get(src)!;
      this.symlinks.set(dst, { target: s.target, mtimeMs: ++this.tick });
      this.symlinks.delete(src);
      return ok(null);
    }
    if (isFile) {
      if (this.dirs.has(dst)) return err({ code: "EISDIR", message: `is a directory: ${to}` });
      this.symlinks.delete(dst);
      const f = this.files.get(src)!;
      this.files.set(dst, { data: f.data, mtimeMs: ++this.tick });
      this.files.delete(src);
      return ok(null);
    }
    if (this.files.has(dst) || this.symlinks.has(dst)) return err({ code: "ENOTDIR", message: `not a directory: ${to}` });
    if (dst.startsWith(`${src}/`)) return err({ code: "EINVAL", message: `cannot move directory inside itself: ${to}` });
    if (this.dirs.has(dst)) {
      const dstPrefix = `${dst}/`;
      const hasChild = [...this.files.keys()].some((k) => k.startsWith(dstPrefix))
        || [...this.symlinks.keys()].some((k) => k.startsWith(dstPrefix))
        || [...this.dirs].some((d) => d.startsWith(dstPrefix));
      if (hasChild) return err({ code: "ENOTEMPTY", message: `directory not empty: ${to}` });
    }
    const srcPrefix = `${src}/`;
    for (const k of [...this.files.keys()]) {
      if (k.startsWith(srcPrefix)) {
        const entry = this.files.get(k)!;
        this.files.delete(k);
        this.files.set(`${dst}${k.slice(src.length)}`, entry);
      }
    }
    for (const s of [...this.symlinks.keys()]) {
      if (s.startsWith(srcPrefix)) {
        const entry = this.symlinks.get(s)!;
        this.symlinks.delete(s);
        this.symlinks.set(`${dst}${s.slice(src.length)}`, entry);
      }
    }
    for (const d of [...this.dirs]) {
      if (d === src || d.startsWith(srcPrefix)) {
        this.dirs.delete(d);
        this.dirs.add(`${dst}${d.slice(src.length)}`);
      }
    }
    return ok(null);
  }

  writeTextAtomic(path: string, text: string) { return this.writeText(path, text); }
  writeBytesAtomic(path: string, data: Slice<number> | Vec<number>) { return this.writeBytes(path, data); }
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

export class FakeProc implements Proc {
  private readonly envMap = new Map<string, string>();
  private curCwd = "/";
  private curArgs: string[] = [];
  private runner: ((req: ProcRequest) => Result<ProcOutput, IoError>) | undefined;
  private readonly callLog: ProcRequest[] = [];
  static create(): FakeProc { return new FakeProc(); }

  setEnv(name: string, value: string): void { this.envMap.set(name, value); }
  setCwd(path: string): void { this.curCwd = path; }
  setArgs(args: readonly string[]): void { this.curArgs = [...args]; }
  onRun(fn: (req: ProcRequest) => Result<ProcOutput, IoError>): void { this.runner = fn; }
  calls(): ProcRequest[] {
    return this.callLog.map((c) => ({ ...c, args: [...c.args], env: c.env.map((e) => ({ name: e.name, value: e.value })) }));
  }

  env(name: string): string | null { return this.envMap.get(name) ?? null; }
  cwd(): string { return this.curCwd; }
  args(): string[] { return [...this.curArgs]; }

  async run(program: string, args: readonly string[], options?: ProcOptions): Promise<Result<ProcOutput, IoError>> {
    const req: ProcRequest = {
      program,
      args: [...args],
      cwd: options?.cwd ?? null,
      env: (options?.env ?? []).map((e) => ({ name: e.name, value: e.value })),
      stdin: options?.stdin ?? null,
      timeoutMs: options?.timeoutMs ?? null,
    };
    this.callLog.push({ ...req, args: [...req.args], env: req.env.map((e) => ({ name: e.name, value: e.value })) });
    if (!program) return err({ code: "EINVAL", message: "Proc.run: empty program" });
    if (!this.runner) return err({ code: "ENOENT", message: `FakeProc: no handler for ${program}` });
    return this.runner(req);
  }
}

export async function webFetch(url: string, init?: HttpRequestInit): Promise<Result<HttpResponse, IoError>> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return err({ code: "EINVAL", message: `Net.fetch: invalid URL: ${url}` }); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return err({ code: "EINVAL", message: `Net.fetch: unsupported protocol '${parsed.protocol}'` });
  }
  const headers = new Headers();
  for (const h of init?.headers ?? []) headers.append(h.name, h.value);
  let ac: AbortController | undefined;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (init?.timeoutMs != null && init.timeoutMs > 0) {
    ac = new AbortController();
    timer = setTimeout(() => { timedOut = true; ac!.abort(); }, init.timeoutMs);
  }
  try {
    const res = await globalThis.fetch(parsed, {
      method: init?.method ?? "GET",
      headers,
      ...(init?.body != null ? { body: init.body } : {}),
      ...(ac ? { signal: ac.signal } : {}),
    });
    const resHeaders: HttpHeader[] = [];
    res.headers.forEach((value, name) => resHeaders.push({ name, value }));
    const body = await res.text();
    return ok({ status: res.status, headers: resHeaders, body });
  } catch (e) {
    if (timedOut) return err({ code: "ETIMEDOUT", message: `Net.fetch: timed out after ${init!.timeoutMs}ms` });
    const x = e as { code?: unknown; cause?: { code?: unknown } };
    const code = typeof x?.code === "string" ? x.code : typeof x?.cause?.code === "string" ? x.cause.code : "EIO";
    return err({ code, message: e instanceof Error ? e.message : String(e) });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class FakeNet implements Net {
  private readonly servers = new Map<string, (req: HttpServerRequest) => Promise<HttpServerResponse>>();
  private fetchHandler: ((req: HttpClientRequest) => Result<HttpResponse, IoError>) | undefined;
  private readonly sent: HttpClientRequest[] = [];
  private nextPort = 18000;
  static create(): FakeNet { return new FakeNet(); }

  onFetch(fn: (req: HttpClientRequest) => Result<HttpResponse, IoError>): void { this.fetchHandler = fn; }
  requests(): HttpClientRequest[] {
    return this.sent.map((r) => ({ ...r, headers: r.headers.map((h) => ({ name: h.name, value: h.value })) }));
  }

  private findServer(host: string, port: number) {
    const alt = host === "localhost" ? "127.0.0.1" : host === "127.0.0.1" ? "localhost" : undefined;
    return this.servers.get(`${host}:${port}`)
      ?? (alt ? this.servers.get(`${alt}:${port}`) : undefined)
      ?? this.servers.get(`0.0.0.0:${port}`);
  }

  async serve(config: HttpServerConfig, handler: (req: HttpServerRequest) => Promise<HttpServerResponse>): Promise<Result<HttpServer, IoError>> {
    if (!config.host || /\s/.test(config.host)) return err({ code: "EINVAL", message: `Net.serve: invalid host '${config.host}'` });
    if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
      return err({ code: "EINVAL", message: `Net.serve: invalid port ${config.port}` });
    }
    let port = config.port;
    if (port === 0) {
      let tries = 0;
      while (this.servers.has(`${config.host}:${this.nextPort}`)) {
        this.nextPort = this.nextPort >= 65535 ? 18000 : this.nextPort + 1;
        if (++tries > 48000) return err({ code: "EADDRINUSE", message: "no ephemeral port available" });
      }
      port = this.nextPort++;
    } else if (this.servers.has(`${config.host}:${port}`)) {
      return err({ code: "EADDRINUSE", message: `address already in use ${config.host}:${port}` });
    }
    const key = `${config.host}:${port}`;
    this.servers.set(key, handler);
    let closed = false;
    let resolveClosed!: () => void;
    const closedP = new Promise<void>((r) => { resolveClosed = r; });
    const stop = (): void => {
      if (closed) return;
      closed = true;
      if (this.servers.get(key) === handler) this.servers.delete(key);
      resolveClosed();
    };
    const close = async (): Promise<void> => {
      stop();
      await closedP;
    };
    return ok({
      host: config.host,
      port,
      stop,
      waitClosed: () => closedP,
      close,
      disposeAsync: close,
      isOpen: () => !closed,
    });
  }

  async fetch(url: string, init?: HttpRequestInit): Promise<Result<HttpResponse, IoError>> {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return err({ code: "EINVAL", message: `Net.fetch: invalid URL: ${url}` }); }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return err({ code: "EINVAL", message: `Net.fetch: unsupported protocol '${parsed.protocol}'` });
    }
    const req: HttpClientRequest = {
      method: init?.method ?? "GET",
      url: parsed.toString(),
      headers: (init?.headers ?? []).map((h) => ({ name: h.name, value: h.value })),
      body: init?.body ?? null,
    };
    this.sent.push({ ...req, headers: req.headers.map((h) => ({ name: h.name, value: h.value })) });

    const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
    const srv = this.findServer(parsed.hostname, port);
    if (srv) {
      const serverReq: HttpServerRequest = {
        method: req.method,
        path: parsed.pathname,
        query: parsed.search.startsWith("?") ? parsed.search.slice(1) : "",
        headers: req.headers.map((h) => ({ name: h.name.toLowerCase(), value: h.value })),
        body: req.body ?? "",
      };
      try {
        const resp = await srv(serverReq);
        return ok({
          status: resp.status,
          headers: resp.headers.map((h) => ({ name: h.name.toLowerCase(), value: h.value })),
          body: resp.body,
        });
      } catch (e) {
        const t = asTrap(e);
        noteIsolateTrap(t
          ? { code: t.code, ...(t.pos ? { file: t.pos.file, line: t.pos.line, col: t.pos.col } : {}), message: t.message }
          : { code: "T006", message: String(e) });
        return err({ code: "ECONNRESET", message: e instanceof Error ? e.message : String(e) });
      }
    }
    if (this.fetchHandler) return this.fetchHandler(req);
    return err({ code: "ECONNREFUSED", message: `FakeNet: no handler for ${url}` });
  }
}

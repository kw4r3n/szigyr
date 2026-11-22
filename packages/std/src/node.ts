import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { basename, dirname, join } from "node:path";
import { asTrap, cast, err, isTrap, noteIsolateTrap, ok, readU8Slice, replaceU8Vec, spawnIsolate, type ForeignTrap, type Result } from "../../runtime-js/src/index.ts";
import { webFetch } from "./fake.ts";
import {
  ALLOC, type Alloc, type Audio, type AudioCallbackSpec, type AudioConfig, type AudioStream, type Clock, type DirEntry,
  type FileStat, type Fs, type FsEntryKind, type HttpHeader, type HttpServer, type HttpServerConfig, type HttpServerRequest,
  type HttpServerResponse, type IoError, type Js, type JsError, type JsRef, type Log, type Net, type Proc, type ProcOptions,
  type ProcOutput, type Random, type Spawn, type System,
} from "./types.ts";

export { ALLOC };

/** Q059: info -> stdout, warn / error -> stderr, each message + "\n", no prefix. */
export function createLog(stdout: (s: string) => void, stderr: (s: string) => void): Log {
  return { info: (m) => stdout(m + "\n"), warn: (m) => stderr(m + "\n"), error: (m) => stderr(m + "\n") };
}

export const nodeClock: Clock = {
  nowMs: () => Date.now(),
  sleep: (ms) => {
    const d = Number.isFinite(ms) && ms > 0 ? Math.min(ms, 2147483647) : 0;
    return new Promise((r) => setTimeout(r, d));
  },
};
export const nodeRandom: Random = {
  nextF64: () => Math.random(),
  nextU32: () => Math.floor(Math.random() * 2 ** 32),
};

const ioError = (e: unknown): IoError => {
  const x = e as { code?: unknown; message?: unknown };
  return { code: typeof x.code === "string" ? x.code : "EIO", message: String(x.message ?? e) };
};
const kindOfStat = (s: { isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean }): FsEntryKind =>
  s.isSymbolicLink() ? "symlink" : s.isDirectory() ? "dir" : s.isFile() ? "file" : "other";
let atomicSeq = 0;
function writeAtomic(path: string, data: string | Uint8Array): Result<null, IoError> {
  if (!path) return err({ code: "EINVAL", message: "empty path" });
  const tmp = join(dirname(path), `.${basename(path)}.sztmp-${process.pid}-${++atomicSeq}-${randomBytes(4).toString("hex")}`);
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", 0o666);
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
    return ok(null);
  } catch (e) {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
    try { unlinkSync(tmp); } catch { /* ignore */ }
    return err(ioError(e));
  }
}

export const nodeFs: Fs = {
  readText(path) { try { return ok(readFileSync(path, "utf8")); } catch (e) { return err(ioError(e)); } },
  writeText(path, text) { try { writeFileSync(path, text); return ok(null); } catch (e) { return err(ioError(e)); } },
  readBytes(path, dst) {
    try {
      const raw = readFileSync(path);
      if (raw.byteLength > 0xffffffff) return err({ code: "EFBIG", message: "file exceeds usize limit (4GiB)" });
      replaceU8Vec(dst, raw);
      return ok(raw.byteLength);
    } catch (e) { return err(ioError(e)); }
  },
  writeBytes(path, data) {
    try { writeFileSync(path, readU8Slice(data)); return ok(null); } catch (e) { return err(ioError(e)); }
  },
  exists(path) { return Boolean(path) && existsSync(path); },
  stat(path) {
    try {
      const s = lstatSync(path, { bigint: true });
      return ok({ kind: kindOfStat(s), size: s.size, mtimeMs: Number(s.mtimeMs) });
    } catch (e) { return err(ioError(e)); }
  },
  readDir(path) {
    try {
      const ds = readdirSync(path, { withFileTypes: true }).map((d): DirEntry => ({ name: d.name, kind: kindOfStat(d) }));
      ds.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return ok(ds);
    } catch (e) { return err(ioError(e)); }
  },
  mkdir(path) { try { mkdirSync(path, { recursive: true }); return ok(null); } catch (e) { return err(ioError(e)); } },
  remove(path) { try { rmSync(path, { recursive: true, force: false }); return ok(null); } catch (e) { return err(ioError(e)); } },
  rename(from, to) { try { renameSync(from, to); return ok(null); } catch (e) { return err(ioError(e)); } },
  writeTextAtomic(path, text) { return writeAtomic(path, text); },
  writeBytesAtomic(path, data) { return writeAtomic(path, readU8Slice(data)); },
};

const activeProcs = new Set<ChildProcess>();
export function stopNodeProcs(): void {
  for (const child of [...activeProcs]) {
    try { child.kill("SIGKILL"); } catch { /* exited */ }
    activeProcs.delete(child);
  }
}

export function createNodeProc(argv?: readonly string[]): Proc {
  return {
    run(program: string, args: readonly string[], options?: ProcOptions): Promise<Result<ProcOutput, IoError>> {
      if (!program) return Promise.resolve(err({ code: "EINVAL", message: "Proc.run: empty program" }));
      if (options?.timeoutMs != null && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 0)) {
        return Promise.resolve(err({ code: "EINVAL", message: `Proc.run: invalid timeoutMs ${options.timeoutMs}` }));
      }
      let mergedEnv: NodeJS.ProcessEnv | undefined;
      if (options?.env?.length) {
        mergedEnv = { ...process.env };
        for (const e of options.env) mergedEnv[e.name] = e.value;
      }
      return new Promise((resolve) => {
        let settled = false;
        let timedOut = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let child: ChildProcess;
        try {
          child = spawn(program, [...args], {
            shell: false,
            stdio: [options?.stdin != null ? "pipe" : "ignore", "pipe", "pipe"],
            ...(options?.cwd != null ? { cwd: options.cwd } : {}),
            ...(mergedEnv ? { env: mergedEnv } : {}),
          });
        } catch (e) {
          resolve(err(ioError(e)));
          return;
        }
        activeProcs.add(child);
        const cleanup = (): void => {
          activeProcs.delete(child);
          if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
        };
        const outChunks: Buffer[] = [];
        const errChunks: Buffer[] = [];
        child.stdout?.on("data", (c: Buffer) => outChunks.push(c));
        child.stderr?.on("data", (c: Buffer) => errChunks.push(c));
        if (options?.timeoutMs != null && options.timeoutMs > 0) {
          timer = setTimeout(() => {
            timedOut = true;
            try { child.kill("SIGKILL"); } catch { /* ignore */ }
          }, options.timeoutMs);
        }
        child.on("error", (e) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(err(ioError(e)));
        });
        child.on("close", (code) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(ok({
            exitCode: code ?? -1,
            stdout: Buffer.concat(outChunks).toString("utf8"),
            stderr: Buffer.concat(errChunks).toString("utf8"),
            timedOut,
          }));
        });
        if (options?.stdin != null && child.stdin) {
          child.stdin.on("error", () => { /* child may exit before reading stdin */ });
          child.stdin.end(options.stdin);
        }
      });
    },
    env(name: string): string | null { return Object.hasOwn(process.env, name) ? process.env[name]! : null; },
    cwd(): string { return process.cwd(); },
    args(): string[] { return argv ? [...argv] : process.argv.slice(2); },
  };
}
export const nodeProc: Proc = createNodeProc();

const activeNetServers = new Set<() => Promise<void>>();
export async function stopNodeNetServers(): Promise<void> {
  for (const close of [...activeNetServers]) await close();
}

export const nodeNet: Net = {
  fetch: webFetch,
  serve(config: HttpServerConfig, handler: (req: HttpServerRequest) => Promise<HttpServerResponse>): Promise<Result<HttpServer, IoError>> {
    if (!config.host) return Promise.resolve(err({ code: "EINVAL", message: "Net.serve: empty host" }));
    if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
      return Promise.resolve(err({ code: "EINVAL", message: `Net.serve: invalid port ${config.port}` }));
    }
    return new Promise((resolve) => {
      let inFlight = 0;
      let closing = false;
      let closed = false;
      let resolveClosed!: () => void;
      const closedP = new Promise<void>((r) => { resolveClosed = r; });

      const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          void (async () => {
            inFlight++;
            const kick = (): void => { if (closing && inFlight === 0) server.closeIdleConnections?.(); };
            res.once("finish", kick);
            res.once("close", kick);
            const u = new URL(req.url ?? "/", "http://127.0.0.1");
            const headers: HttpHeader[] = [];
            for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
              headers.push({ name: req.rawHeaders[i]!.toLowerCase(), value: req.rawHeaders[i + 1]! });
            }
            const httpReq: HttpServerRequest = {
              method: req.method ?? "GET",
              path: u.pathname,
              query: u.search.startsWith("?") ? u.search.slice(1) : "",
              headers,
              body: Buffer.concat(chunks).toString("utf8"),
            };
            try {
              const resp = await handler(httpReq);
              res.statusCode = resp.status;
              for (const h of resp.headers) res.appendHeader(h.name, h.value);
              if (closing && !res.headersSent) res.setHeader("connection", "close");
              res.end(resp.body);
            } catch (e) {
              const t = asTrap(e);
              const ft: ForeignTrap = t
                ? { code: t.code, ...(t.pos ? { file: t.pos.file, line: t.pos.line, col: t.pos.col } : {}), message: t.message }
                : { code: "T006", message: String(e) };
              noteIsolateTrap(ft);
              if (closing && !res.headersSent) res.setHeader("connection", "close");
              if (!res.headersSent) { res.statusCode = 500; res.end("internal error"); }
              else if (!res.writableEnded) { res.end(); }
            } finally {
              inFlight--;
              if (closing && inFlight === 0 && res.writableEnded) server.closeIdleConnections?.();
            }
          })();
        });
      });
      const onListenErr = (e: Error): void => {
        server.removeListener("listening", onListening);
        resolve(err(ioError(e)));
      };
      let forceClose!: () => Promise<void>;
      const stop = (): void => {
        if (closing) return;
        closing = true;
        activeNetServers.delete(forceClose);
        server.close(() => { closed = true; resolveClosed(); });
        server.closeIdleConnections?.();
      };
      forceClose = async (): Promise<void> => {
        stop();
        if (!closed && inFlight === 0) server.closeAllConnections?.();
        await closedP;
      };
      const onListening = (): void => {
        server.removeListener("error", onListenErr);
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : config.port;
        activeNetServers.add(forceClose);
        resolve(ok({
          host: config.host,
          port,
          stop,
          waitClosed: () => closedP,
          close: forceClose,
          disposeAsync: forceClose,
          isOpen: () => !closing && !closed,
        }));
      };
      server.once("error", onListenErr);
      server.once("listening", onListening);
      server.listen(config.port, config.host);
    });
  },
};

export const nodeSpawn: Spawn = {
  isolate: (path, name) => spawnIsolate(path, name),
};

const jsError = (e: unknown): JsError => ({
  code: e instanceof Error ? e.name : "Error",
  message: e instanceof Error ? e.message : String(e),
});
// Traps are not catchable from Szigyr code (§8): they pass through the Js boundary.
const guard = <T>(f: () => T): Result<T, JsError> => { try { return ok(f()); } catch (e) { if (isTrap(e)) throw e; return err(jsError(e)); } };

export const nodeJs: Js = {
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

let registeredAudio: Audio = {
  async open(_c: AudioConfig, _s: unknown, _cb: AudioCallbackSpec): Promise<Result<AudioStream, IoError>> {
    return err({ code: "ENOSYS", message: "audio host not configured" });
  },
};
/** Compiler / CLI wires SDL3 audio implementation here so `std` stays Node-API-free. */
export function setNodeAudio(audio: Audio): void { registeredAudio = audio; }
export const nodeAudio: Audio = {
  open: (config, state, cb) => registeredAudio.open(config, state, cb),
};

export function createSystem(
  stdout: (s: string) => void = (s) => void process.stdout.write(s),
  stderr: (s: string) => void = (s) => void process.stderr.write(s),
  opts?: { args?: readonly string[] },
): System {
  return {
    alloc: ALLOC,
    fs: nodeFs,
    clock: nodeClock,
    random: nodeRandom,
    log: createLog(stdout, stderr),
    js: nodeJs,
    spawn: nodeSpawn,
    audio: nodeAudio,
    net: nodeNet,
    proc: opts?.args ? createNodeProc(opts.args) : nodeProc,
  };
}

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { basename, dirname, join } from "node:path";
import { asTrap, err, noteIsolateTrap, ok, readU8Slice, replaceU8Vec, spawnIsolate, type ForeignTrap, type Pos, type Result, type Slice, type Vec } from "../../runtime-js/src/index.ts";
import { createLog, hostClock, hostJs, hostRandom, readDisplayRgba, validateDisplayConfig, webFetch } from "./fake.ts";
import {
  ALLOC, type Alloc, type Audio, type AudioCallbackSpec, type AudioConfig, type AudioStream, type Clock, type DirEntry,
  type Display, type DisplayColor, type DisplayConfig, type DisplayEvent, type DisplaySurface,
  type FileStat, type Fs, type FsEntryKind, type HttpHeader, type HttpServer, type HttpServerConfig, type HttpServerRawResponse, type HttpServerRequest,
  type HttpServerResponse, type IoError, type Js, type Log, type Net, type Proc, type ProcOptions,
  type ProcOutput, type Random, type Spawn, type System,
} from "./types.ts";

export { ALLOC, createLog };
export const nodeClock: Clock = hostClock;
export const nodeRandom: Random = hostRandom;

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

const procExitCodes = new WeakMap<Proc, () => number>();
export const getProcExitCode = (proc: Proc): number => procExitCodes.get(proc)?.() ?? 0;

export function createNodeProc(argv?: readonly string[]): Proc {
  let exitCode = 0;
  const proc: Proc = {
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
        const MAX_PROC_OUTPUT_BYTES = 16 * 1024 * 1024;
        const outChunks: Buffer[] = [];
        const errChunks: Buffer[] = [];
        let totalBytes = 0;
        const onOutChunk = (dst: Buffer[]) => (c: Buffer): void => {
          if (settled) return;
          totalBytes += c.length;
          if (totalBytes > MAX_PROC_OUTPUT_BYTES) {
            settled = true;
            outChunks.length = 0;
            errChunks.length = 0;
            cleanup();
            try { child.kill("SIGKILL"); } catch { /* ignore */ }
            resolve(err({ code: "EFBIG", message: `process output exceeded ${MAX_PROC_OUTPUT_BYTES} bytes` }));
            return;
          }
          dst.push(c);
        };
        child.stdout?.on("data", onOutChunk(outChunks));
        child.stderr?.on("data", onOutChunk(errChunks));
        if (options?.timeoutMs != null && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
          timer = setTimeout(() => {
            timedOut = true;
            try { child.kill("SIGKILL"); } catch { /* ignore */ }
          }, Math.min(2_147_483_647, options.timeoutMs));
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
    setExitCode(code: number): void { exitCode = code & 0xff; },
  };
  procExitCodes.set(proc, () => exitCode);
  return proc;
}
export const nodeProc: Proc = createNodeProc();

const activeNetServers = new Set<() => Promise<void>>();
export async function stopNodeNetServers(): Promise<void> {
  for (const close of [...activeNetServers]) await close();
}

const MAX_HTTP_BODY_BYTES = 16 * 1024 * 1024;

function parseRequestTarget(rawUrl: string): { path: string; query: string } | undefined {
  if (rawUrl.startsWith("/")) {
    const qIdx = rawUrl.indexOf("?");
    return qIdx >= 0 ? { path: rawUrl.slice(0, qIdx), query: rawUrl.slice(qIdx + 1) } : { path: rawUrl, query: "" };
  }
  if (rawUrl === "*") return { path: "*", query: "" };
  try {
    const u = new URL(rawUrl);
    return { path: u.pathname, query: u.search.startsWith("?") ? u.search.slice(1) : "" };
  } catch {
    return undefined;
  }
}

function serveHttp(config: HttpServerConfig, handler: (req: HttpServerRequest) => Promise<HttpServerRawResponse>): Promise<Result<HttpServer, IoError>> {
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
      let totalBytes = 0;
      let tooLarge = false;
      req.on("error", () => {});
      req.on("data", (c: Buffer) => {
        if (tooLarge) return;
        totalBytes += c.length;
        if (totalBytes > MAX_HTTP_BODY_BYTES) {
          tooLarge = true;
          chunks.length = 0;
          if (!res.headersSent) { res.statusCode = 413; res.end("payload too large"); }
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        if (tooLarge || req.destroyed) return;
        void (async () => {
          inFlight++;
          const kick = (): void => { if (closing && inFlight === 0) server.closeIdleConnections?.(); };
          res.once("finish", kick);
          res.once("close", kick);
          try {
            const target = parseRequestTarget(req.url ?? "/");
            if (!target) {
              if (!res.headersSent) { res.statusCode = 400; res.end("bad request"); }
              return;
            }
            const headers: HttpHeader[] = [];
            for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
              headers.push({ name: req.rawHeaders[i]!.toLowerCase(), value: req.rawHeaders[i + 1]! });
            }
            const httpReq: HttpServerRequest = {
              method: req.method ?? "GET",
              path: target.path,
              query: target.query,
              headers,
              body: Buffer.concat(chunks).toString("utf8"),
            };
            const resp = await handler(httpReq);
            res.statusCode = resp.status;
            for (const h of resp.headers) res.appendHeader(h.name, h.value);
            if (closing && !res.headersSent) res.setHeader("connection", "close");
            res.end(resp.body.kind === "text" ? resp.body.value : Uint8Array.from(resp.body.value));
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
}

export const nodeNet: Net = {
  fetch: webFetch,
  serve: (config, handler) =>
    serveHttp(config, async (req) => {
      const r = await handler(req);
      return { status: r.status, headers: r.headers, body: { kind: "text", value: r.body } };
    }),
  serveRaw: serveHttp,
};

export const nodeSpawn: Spawn = {
  isolate: (path, name) => spawnIsolate(path, name),
};

export const nodeJs: Js = hostJs;

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

export interface DisplayAddon {
  open(title: string, width: number, height: number): unknown;
  clear(surf: unknown, r: number, g: number, b: number, a: number): void;
  fillRect(surf: unknown, x: number, y: number, w: number, h: number, r: number, g: number, b: number, a: number): void;
  strokeRect(surf: unknown, x: number, y: number, w: number, h: number, r: number, g: number, b: number, a: number): void;
  drawLine(surf: unknown, x1: number, y1: number, x2: number, y2: number, r: number, g: number, b: number, a: number): void;
  drawText(surf: unknown, x: number, y: number, text: string, r: number, g: number, b: number, a: number): void;
  blit(surf: unknown, bytes: Uint8Array, srcW: number, srcH: number, dx: number, dy: number, dw: number, dh: number): void;
  present(surf: unknown): void;
  poll(surf: unknown): DisplayEvent[];
  close(surf: unknown): void;
}

const activeDisplayClosers = new Set<() => Promise<void>>();
export async function stopNodeDisplays(): Promise<void> {
  for (const close of [...activeDisplayClosers]) await close();
}

export function createSdlDisplay(getAddon: () => DisplayAddon): Display {
  const normKey = (k: string): string => {
    switch (k) {
      case "Return": return "Enter";
      case "Left": return "ArrowLeft";
      case "Right": return "ArrowRight";
      case "Up": return "ArrowUp";
      case "Down": return "ArrowDown";
      case "Page Up": return "PageUp";
      case "Page Down": return "PageDown";
      default: return k.length === 1 && k >= "A" && k <= "Z" ? k.toLowerCase() : k;
    }
  };
  return {
    async open(config: DisplayConfig): Promise<Result<DisplaySurface, IoError>> {
      const valid = validateDisplayConfig(config);
      if (valid.kind === "err") return valid;
      const { width, height } = valid.value;
      let addon: DisplayAddon;
      try { addon = getAddon(); } catch (e) { return err({ code: "ENOENT", message: (e as Error).message }); }
      const ext = addon.open(config.title, width, height);
      if (ext !== null && typeof ext === "object" && "error" in (ext as Record<string, unknown>)) {
        const eo = ext as { code?: string; error: string };
        return err({ code: eo.code ?? "EIO", message: eo.error });
      }
      let closed = false;
      const close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        activeDisplayClosers.delete(close);
        addon.close(ext);
      };
      activeDisplayClosers.add(close);
      const surface: DisplaySurface = {
        width,
        height,
        clear: (c: DisplayColor): void => { if (!closed) addon.clear(ext, c.r & 255, c.g & 255, c.b & 255, c.a & 255); },
        fillRect: (x: number, y: number, w: number, h: number, c: DisplayColor): void => {
          if (!closed && w > 0 && h > 0) addon.fillRect(ext, x, y, w, h, c.r & 255, c.g & 255, c.b & 255, c.a & 255);
        },
        strokeRect: (x: number, y: number, w: number, h: number, c: DisplayColor): void => {
          if (!closed && w > 0 && h > 0) addon.strokeRect(ext, x, y, w, h, c.r & 255, c.g & 255, c.b & 255, c.a & 255);
        },
        drawLine: (x1: number, y1: number, x2: number, y2: number, c: DisplayColor): void => {
          if (!closed) addon.drawLine(ext, x1, y1, x2, y2, c.r & 255, c.g & 255, c.b & 255, c.a & 255);
        },
        drawText: (x: number, y: number, text: string, c: DisplayColor): void => {
          if (!closed) addon.drawText(ext, x, y, text, c.r & 255, c.g & 255, c.b & 255, c.a & 255);
        },
        blitRgba: (pixels: Slice<number> | Vec<number>, srcW: number, srcH: number, dx: number, dy: number, dw: number, dh: number, pos?: Pos): void => {
          const raw = readDisplayRgba(pixels, srcW, srcH, pos);
          if (closed || srcW === 0 || srcH === 0 || !(dw > 0 && dh > 0)) return;
          const need = srcW * srcH * 4;
          addon.blit(ext, raw.length === need ? raw : raw.subarray(0, need), srcW, srcH, dx, dy, dw, dh);
        },
        present: async (): Promise<void> => {
          if (closed) return;
          addon.present(ext);
          await new Promise<void>((r) => setImmediate(r));
        },
        pollEvents: (): DisplayEvent[] =>
          closed
            ? []
            : addon.poll(ext).map((ev) => (ev.kind === "keyDown" || ev.kind === "keyUp" ? { ...ev, key: normKey(ev.key) } : ev)),
        close,
        disposeAsync: close,
        isOpen: (): boolean => !closed,
      };
      return ok(surface);
    },
  };
}

let registeredDisplay: Display = {
  async open(_c: DisplayConfig): Promise<Result<DisplaySurface, IoError>> {
    return err({ code: "ENOSYS", message: "display host not configured" });
  },
};
/** Compiler / CLI wires SDL3 display implementation here so `std` stays Node-API-free. */
export function setNodeDisplay(display: Display): void { registeredDisplay = display; }
export const nodeDisplay: Display = {
  open: (config) => registeredDisplay.open(config),
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
    display: nodeDisplay,
    net: nodeNet,
    proc: createNodeProc(opts?.args),
  };
}

import type { Port, Result, Slice, TypeDesc, CastError, Vec } from "../../runtime-js/src/index.ts";

export interface IoError { readonly code: string; readonly message: string }
/** Q036: code is the JS exception's name. */
export interface JsError { readonly code: string; readonly message: string }
export type JsRef = unknown;
export type FsEntryKind = "file" | "dir" | "symlink" | "other";
export interface DirEntry { readonly name: string; readonly kind: FsEntryKind }
export interface FileStat { readonly kind: FsEntryKind; readonly size: bigint; readonly mtimeMs: number }
export interface EnvVar { readonly name: string; readonly value: string }
export interface ProcOptions { readonly cwd: string | null; readonly env: readonly EnvVar[]; readonly stdin: string | null; readonly timeoutMs: number | null }
export interface ProcOutput { readonly exitCode: number; readonly stdout: string; readonly stderr: string; readonly timedOut: boolean }
export interface ProcRequest { readonly program: string; readonly args: string[]; readonly cwd: string | null; readonly env: EnvVar[]; readonly stdin: string | null; readonly timeoutMs: number | null }
export interface HttpHeader { readonly name: string; readonly value: string }
export interface HttpRequestInit { readonly method: string; readonly headers: readonly HttpHeader[]; readonly body: string | null; readonly timeoutMs: number | null }
export interface HttpResponse { readonly status: number; readonly headers: HttpHeader[]; readonly body: string }
export interface HttpServerConfig { readonly host: string; readonly port: number }
export interface HttpServerRequest { readonly method: string; readonly path: string; readonly query: string; readonly headers: HttpHeader[]; readonly body: string }
export interface HttpServerResponse { readonly status: number; readonly headers: readonly HttpHeader[]; readonly body: string }
export type HttpBody =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "bytes"; readonly value: readonly number[] };
export interface HttpServerRawResponse { readonly status: number; readonly headers: readonly HttpHeader[]; readonly body: HttpBody }
export interface HttpClientRequest { readonly method: string; readonly url: string; readonly headers: HttpHeader[]; readonly body: string | null }
export interface QueryParam { readonly name: string; readonly value: string }
export interface HttpServer {
  readonly host: string;
  readonly port: number;
  stop(): void;
  waitClosed(): Promise<void>;
  close(): Promise<void>;
  disposeAsync(): Promise<void>;
  isOpen(): boolean;
}

export interface Log { info(msg: string): void; warn(msg: string): void; error(msg: string): void }
export interface Clock { nowMs(): number; sleep(ms: number): Promise<void> }
export interface Random { nextF64(): number; nextU32(): number }
export interface Fs {
  readText(path: string): Result<string, IoError>;
  writeText(path: string, text: string): Result<null, IoError>;
  readBytes(path: string, dst: Vec<number>): Result<number, IoError>;
  writeBytes(path: string, data: Slice<number> | Vec<number>): Result<null, IoError>;
  exists(path: string): boolean;
  stat(path: string): Result<FileStat, IoError>;
  readDir(path: string): Result<DirEntry[], IoError>;
  mkdir(path: string): Result<null, IoError>;
  remove(path: string): Result<null, IoError>;
  rename(from: string, to: string): Result<null, IoError>;
  writeTextAtomic(path: string, text: string): Result<null, IoError>;
  writeBytesAtomic(path: string, data: Slice<number> | Vec<number>): Result<null, IoError>;
}
export interface Proc {
  run(program: string, args: readonly string[], options?: ProcOptions): Promise<Result<ProcOutput, IoError>>;
  env(name: string): string | null;
  cwd(): string;
  args(): string[];
  setExitCode(code: number): void;
}
export interface Net {
  fetch(url: string, init?: HttpRequestInit): Promise<Result<HttpResponse, IoError>>;
  serve(config: HttpServerConfig, handler: (req: HttpServerRequest) => Promise<HttpServerResponse>): Promise<Result<HttpServer, IoError>>;
  serveRaw(config: HttpServerConfig, handler: (req: HttpServerRequest) => Promise<HttpServerRawResponse>): Promise<Result<HttpServer, IoError>>;
}
export interface Spawn {
  isolate(path: string, name: string, fn: (port: Port, alloc: Alloc) => unknown): Port;
}
export interface Alloc { readonly kind: "alloc" }
export const ALLOC: Alloc = { kind: "alloc" };
export interface AudioConfig { readonly sampleRate: number; readonly channels: number }
export interface AudioStream { readonly sampleRate: number; readonly channels: number; close(): Promise<void>; disposeAsync(): Promise<void>; isOpen(): boolean }
export interface AudioCallbackSpec {
  readonly fn: (state: unknown, out: Slice<number>, frames: number) => void;
  readonly id: number;
  readonly native?: Record<string, unknown>;
}
export interface Audio {
  open(config: AudioConfig, state: unknown, cb: AudioCallbackSpec): Promise<Result<AudioStream, IoError>>;
}
export interface Js {
  call(f: JsRef, args: readonly JsRef[]): Result<JsRef, JsError>;
  readonly new: (ctor: JsRef, args: readonly JsRef[]) => Result<JsRef, JsError>;
  invoke(obj: JsRef, method: string, args: readonly JsRef[]): Result<JsRef, JsError>;
  get(obj: JsRef, key: string): Result<JsRef, JsError>;
  set(obj: JsRef, key: string, value: JsRef): Result<null, JsError>;
  object(entries: readonly { readonly key: string; readonly value: JsRef }[]): JsRef;
  await(v: JsRef): Promise<Result<JsRef, JsError>>;
  /** `desc` describes T (same descriptor as cast). */
  decode<T>(v: JsRef, desc: TypeDesc): Result<T, CastError>;
  encode<T>(v: T): JsRef;
  /** Q128: a JS function that calls `f` with its first argument checked against `desc` (T) like decode; extra arguments are dropped, the result is undefined. */
  callback<T>(f: (arg: Result<T, CastError>) => void, desc: TypeDesc): JsRef;
  /** Wraps a Szigyr function as a multi-arg returning JS function receiving raw `JsRef[]`. */
  fn(f: (args: JsRef[]) => JsRef): JsRef;
}
export interface System { readonly alloc: Alloc; readonly fs: Fs; readonly clock: Clock; readonly random: Random; readonly log: Log; readonly js: Js; readonly spawn: Spawn; readonly audio: Audio; readonly net: Net; readonly proc: Proc }

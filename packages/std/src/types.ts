import type { Port, Result, Slice, TypeDesc, CastError, Vec } from "../../runtime-js/src/index.ts";

export interface IoError { readonly code: string; readonly message: string }
/** Q036: code is the JS exception's name. */
export interface JsError { readonly code: string; readonly message: string }
export type JsRef = unknown;

export interface Log { info(msg: string): void; warn(msg: string): void; error(msg: string): void }
export interface Clock { nowMs(): number; sleep(ms: number): Promise<void> }
export interface Random { nextF64(): number; nextU32(): number }
export interface Fs {
  readText(path: string): Result<string, IoError>;
  writeText(path: string, text: string): Result<null, IoError>;
  readBytes(path: string, dst: Vec<number>): Result<number, IoError>;
  writeBytes(path: string, data: Slice<number> | Vec<number>): Result<null, IoError>;
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
/** Net is reserved. */
export interface System { readonly alloc: Alloc; readonly fs: Fs; readonly clock: Clock; readonly random: Random; readonly log: Log; readonly js: Js; readonly spawn: Spawn; readonly audio: Audio }

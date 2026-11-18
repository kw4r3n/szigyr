import type { Result, TypeDesc, CastError } from "../../runtime-js/src/index.ts";

export interface IoError { readonly code: string; readonly message: string }
/** Q036: code is the JS exception's name. */
export interface JsError { readonly code: string; readonly message: string }
export type JsRef = unknown;

export interface Log { info(msg: string): void; warn(msg: string): void; error(msg: string): void }
export interface Clock { nowMs(): number }
export interface Random { nextF64(): number; nextU32(): number }
export interface Fs {
  readText(path: string): Result<string, IoError>;
  writeText(path: string, text: string): Result<null, IoError>;
}
export interface Alloc { readonly kind: "alloc" }
export interface Js {
  call(f: JsRef, args: JsRef[]): Result<JsRef, JsError>;
  get(obj: JsRef, key: string): Result<JsRef, JsError>;
  await(v: JsRef): Promise<Result<JsRef, JsError>>;
  /** `desc` describes T (same descriptor as cast). */
  decode<T>(v: JsRef, desc: TypeDesc): Result<T, CastError>;
  encode<T>(v: T): JsRef;
  /** Q128: a JS function that calls `f` with its first argument checked against `desc` (T) like decode; extra arguments are dropped, the result is undefined. */
  callback<T>(f: (arg: Result<T, CastError>) => void, desc: TypeDesc): JsRef;
}
/** Net is reserved. */
export interface System { readonly alloc: Alloc; readonly fs: Fs; readonly clock: Clock; readonly random: Random; readonly log: Log; readonly js: Js }

import { trap, type Pos } from "./trap.ts";
import type { NumType } from "./num.ts";

const inBounds = (i: number, len: number): boolean => Number.isInteger(i) && i >= 0 && i < len;

type Buf<T> = T[] | Float64Array | Float32Array | Int8Array | Int16Array | Int32Array | Uint8Array | Uint16Array | Uint32Array;
type TypedCtor = new (n: number) => Exclude<Buf<never>, never[]>;
const TYPED: Record<NumType, TypedCtor> = {
  i8: Int8Array, i16: Int16Array, i32: Int32Array, u8: Uint8Array, u16: Uint16Array, u32: Uint32Array,
  usize: Uint32Array, f32: Float32Array, f64: Float64Array,
};
/** Element kind the translator passes to Vec.create: a number type, or anything else for a plain array. */
export type ElemKind = NumType | "other";

export class Slice<T = unknown> {
  /** Only Vec.slice and Vec.view construct these. */
  private readonly buf: Buf<T>;
  private readonly off: number;
  readonly length: number;
  constructor(buf: Buf<T>, off: number, length: number) { this.buf = buf; this.off = off; this.length = length; }
  get(i: number, pos?: Pos): T {
    if (!inBounds(i, this.length)) trap("T002", `index ${i} out of range (length ${this.length})`, pos);
    return this.buf[this.off + i] as T;
  }
  set(i: number, x: T, pos?: Pos): void {
    if (!inBounds(i, this.length)) trap("T002", `index ${i} out of range (length ${this.length})`, pos);
    (this.buf as T[])[this.off + i] = x;
  }
  fill(x: T): void { (this.buf as T[]).fill(x, this.off, this.off + this.length); }
  slice(start: number, end: number, pos?: Pos): Slice<T> {
    if (!(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start <= end && end <= this.length))
      trap("T002", `slice ${start}..${end} out of range (length ${this.length})`, pos);
    return new Slice(this.buf, this.off + start, end - start);
  }
}

export class Vec<T = unknown> {
  private len = 0;
  private buf: Buf<T>;
  private readonly elem: ElemKind;
  private constructor(buf: Buf<T>, elem: ElemKind) { this.buf = buf; this.elem = elem; }
  /** `alloc` is accepted for the signature only. */
  static create<T>(_alloc: unknown, capacity: number, elem: ElemKind = "other"): Vec<T> {
    return new Vec<T>(elem === "other" ? [] : new TYPED[elem](Math.max(capacity, 4)), elem);
  }
  get length(): number { return this.len; }
  get(i: number, pos?: Pos): T {
    if (!inBounds(i, this.len)) trap("T002", `index ${i} out of range (length ${this.len})`, pos);
    return this.buf[i] as T;
  }
  set(i: number, x: T, pos?: Pos): void {
    if (!inBounds(i, this.len)) trap("T002", `index ${i} out of range (length ${this.len})`, pos);
    (this.buf as T[])[i] = x;
  }
  push(x: T): void {
    if (this.elem !== "other" && this.len === this.buf.length) {
      const bigger = new TYPED[this.elem](this.len * 2);
      bigger.set(this.buf as Float64Array);
      this.buf = bigger as Buf<T>;
    }
    (this.buf as T[])[this.len++] = x;
  }
  pop(): T | null { return this.len === 0 ? null : (this.buf[--this.len] as T); }
  clear(): void { this.len = 0; }
  fill(x: T): void { (this.buf as T[]).fill(x, 0, this.len); }
  slice(start: number, end: number, pos?: Pos): Slice<T> {
    if (!(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start <= end && end <= this.len))
      trap("T002", `slice ${start}..${end} out of range (length ${this.len})`, pos);
    return new Slice(this.buf, start, end - start);
  }
  /** Whole-vector view, for passing a Vec where a Slice parameter is expected. */
  view(): Slice<T> { return new Slice(this.buf, 0, this.len); }
}

/** a[i] / a[i] = x for Array, Vec and Slice (T002). */
export function at<T>(a: readonly T[] | Vec<T> | Slice<T>, i: number, pos?: Pos): T {
  if (Array.isArray(a)) {
    if (!inBounds(i, a.length)) trap("T002", `index ${i} out of range (length ${a.length})`, pos);
    return a[i] as T;
  }
  return (a as Vec<T>).get(i, pos);
}
export function setAt<T>(a: T[] | Vec<T> | Slice<T>, i: number, x: T, pos?: Pos): void {
  if (Array.isArray(a)) {
    if (!inBounds(i, a.length)) trap("T002", `index ${i} out of range (length ${a.length})`, pos);
    a[i] = x;
  } else (a as Vec<T>).set(i, x, pos);
}

export class OwnedCell<T> {
  private value: T | undefined;
  private full: boolean;
  private constructor(value: T | undefined, full: boolean) { this.value = value; this.full = full; }
  static create<T>(v: T): OwnedCell<T> { return new OwnedCell<T>(v, true); }
  take(pos?: Pos): T {
    if (!this.full) trap("T008", "take from empty OwnedCell", pos);
    const v = this.value as T;
    this.value = undefined;
    this.full = false;
    return v;
  }
  put(v: T, pos?: Pos): void {
    if (this.full) trap("T008", "put into full OwnedCell", pos);
    this.value = v;
    this.full = true;
  }
  isEmpty(): boolean { return !this.full; }
}

/** undefined -> null (Map.get, find, ?. ...). */
export const nn = <T>(x: T | undefined): T | null => (x === undefined ? null : x);
/** indexOf / findIndex: -1 -> null (Q031). */
export const idxOrNull = (i: number): number | null => (i < 0 ? null : i);
/** charCodeAt: out of range -> T002 (Q031). */
export function charCodeAt(s: string, i: number, pos?: Pos): number {
  if (!inBounds(i, s.length)) trap("T002", `index ${i} out of range (length ${s.length})`, pos);
  return s.charCodeAt(i);
}

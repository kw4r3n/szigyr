import { trap, type Pos } from "./trap.ts";
import type { NumType } from "./num.ts";

const inBounds = (i: number, len: number): boolean => Number.isInteger(i) && i >= 0 && i < len;

type Buf<T> = T[] | Float64Array | Float32Array | Int8Array | Int16Array | Int32Array | Uint8Array | Uint16Array | Uint32Array;
type TypedCtor = new (n: number) => Exclude<Buf<never>, never[]>;
const TYPED: Record<NumType, TypedCtor> = {
  i8: Int8Array, i16: Int16Array, i32: Int32Array, u8: Uint8Array, u16: Uint16Array, u32: Uint32Array,
  usize: Uint32Array, f32: Float32Array, f64: Float64Array,
};
/** Element kind the translator passes to Vec.create: a number type, the JSON of a byte layout (SPEC §10.2, D105), or "other" for a plain array. */
export type ElemKind = NumType | "other" | `{${string}`;

type Lay =
  | { t: "num"; n: NumType; z: number } | { t: "bool"; z: number } | { t: "lit"; v: string[]; z: number }
  | { t: "rec"; f: { n: string; o: number; l: Lay }[]; z: number } | { t: "uni"; m: Lay[]; z: number } | { t: "opt"; o: number; l: Lay; z: number };
interface Codec { readonly z: number; rd(d: DataView, p: number): unknown; wr(d: DataView, p: number, x: unknown): void }
const LE = true;
const NUM_RW: Record<NumType, [(d: DataView, p: number) => number, (d: DataView, p: number, x: number) => void]> = {
  i8: [(d, p) => d.getInt8(p), (d, p, x) => d.setInt8(p, x)], u8: [(d, p) => d.getUint8(p), (d, p, x) => d.setUint8(p, x)],
  i16: [(d, p) => d.getInt16(p, LE), (d, p, x) => d.setInt16(p, x, LE)], u16: [(d, p) => d.getUint16(p, LE), (d, p, x) => d.setUint16(p, x, LE)],
  i32: [(d, p) => d.getInt32(p, LE), (d, p, x) => d.setInt32(p, x, LE)], u32: [(d, p) => d.getUint32(p, LE), (d, p, x) => d.setUint32(p, x, LE)],
  usize: [(d, p) => d.getUint32(p, LE), (d, p, x) => d.setUint32(p, x, LE)],
  f32: [(d, p) => d.getFloat32(p, LE), (d, p, x) => d.setFloat32(p, x, LE)], f64: [(d, p) => d.getFloat64(p, LE), (d, p, x) => d.setFloat64(p, x, LE)],
};
function codec(l: Lay): Codec {
  switch (l.t) {
    case "num": { const [rd, wr] = NUM_RW[l.n]; return { z: l.z, rd, wr: wr as Codec["wr"] }; }
    case "bool": return { z: 1, rd: (d, p) => d.getUint8(p) !== 0, wr: (d, p, x) => d.setUint8(p, x ? 1 : 0) };
    case "lit": { const v = l.v; return { z: 4, rd: (d, p) => v[d.getUint32(p, LE)], wr: (d, p, x) => d.setUint32(p, v.indexOf(x as string), LE) }; }
    case "rec": {
      const fs = l.f.map((f) => ({ n: f.n, o: f.o, c: codec(f.l) }));
      return {
        z: l.z,
        rd: (d, p) => { const r: Record<string, unknown> = {}; for (const f of fs) r[f.n] = f.c.rd(d, p + f.o); return r; },
        wr: (d, p, x) => { for (const f of fs) f.c.wr(d, p + f.o, (x as Record<string, unknown>)[f.n]); },
      };
    }
    case "uni": {
      const ms = l.m.map(codec), ks = l.m.map((m) => (m as Extract<Lay, { t: "rec" }>).f[0]!.l as Extract<Lay, { t: "lit" }>)[0]!.v;
      return { z: l.z, rd: (d, p) => ms[d.getUint32(p, LE)]!.rd(d, p), wr: (d, p, x) => ms[ks.indexOf((x as { kind: string }).kind)]!.wr(d, p, x) };
    }
    case "opt": {
      const c = codec(l.l), o = l.o;
      return { z: l.z, rd: (d, p) => (d.getUint8(p) ? c.rd(d, p + o) : null), wr: (d, p, x) => { d.setUint8(p, x === null ? 0 : 1); if (x !== null) c.wr(d, p + o, x); } };
    }
  }
}
const codecs = new Map<string, Codec>();
const codecOf = (elem: string): Codec => { let c = codecs.get(elem); if (!c) codecs.set(elem, c = codec(JSON.parse(elem) as Lay)); return c; };
/** Packed (byte-layout) storage: element accessors over a Uint8Array whose buffer C may replace on growth. */
const dvs = new WeakMap<ArrayBufferLike, DataView>();
const dvOf = (u: Uint8Array): DataView => { let d = dvs.get(u.buffer); if (!d) dvs.set(u.buffer, d = new DataView(u.buffer, u.byteOffset, u.byteLength)); return d; };

export class Slice<T = unknown> {
  /** Only Vec.slice and Vec.view construct these. */
  private buf: Buf<T>;
  private readonly off: number;
  readonly length: number;
  private cod: Codec | undefined;
  /** The Vec this views, so a view of a type-parameter Vec can switch representation with it (D105). */
  private readonly owner: Vec<T> | undefined;
  constructor(buf: Buf<T>, off: number, length: number, cod?: Codec, owner?: Vec<T>) { this.buf = buf; this.off = off; this.length = length; this.cod = cod; this.owner = owner; }
  /** C boundary: a view of a Vec made with a type parameter as its element type ("other") adopts `elem` together with that Vec. */
  adopt(elem: ElemKind): void {
    if (!this.owner || !Array.isArray(this.buf)) return;
    this.owner.adopt(elem);
    const o = this.owner as unknown as { buf: Buf<T>; cod: Codec | undefined };
    this.buf = o.buf; this.cod = o.cod;
  }
  get(i: number, pos?: Pos): T {
    if (!inBounds(i, this.length)) trap("T002", `index ${i} out of range (length ${this.length})`, pos);
    if (this.cod) return this.cod.rd(dvOf(this.buf as Uint8Array), (this.off + i) * this.cod.z) as T;
    return this.buf[this.off + i] as T;
  }
  set(i: number, x: T, pos?: Pos): void {
    if (!inBounds(i, this.length)) trap("T002", `index ${i} out of range (length ${this.length})`, pos);
    if (this.cod) this.cod.wr(dvOf(this.buf as Uint8Array), (this.off + i) * this.cod.z, x);
    else (this.buf as T[])[this.off + i] = x;
  }
  fill(x: T): void {
    if (this.cod) for (let i = 0; i < this.length; i++) this.set(i, x);
    else (this.buf as T[]).fill(x, this.off, this.off + this.length);
  }
  slice(start: number, end: number, pos?: Pos): Slice<T> {
    if (!(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start <= end && end <= this.length))
      trap("T002", `slice ${start}..${end} out of range (length ${this.length})`, pos);
    return new Slice(this.buf, this.off + start, end - start, this.cod, this.owner);
  }
}

export class Vec<T = unknown> {
  private len = 0;
  private buf: Buf<T>;
  private elem: ElemKind;
  private cod: Codec | undefined;
  private constructor(buf: Buf<T>, elem: ElemKind, cod?: Codec) { this.buf = buf; this.elem = elem; this.cod = cod; }
  /** `alloc` is accepted for the signature only. */
  static create<T>(_alloc: unknown, capacity: number, elem: ElemKind = "other"): Vec<T> {
    if (elem === "other") return new Vec<T>([], elem);
    if (elem.startsWith("{")) { const c = codecOf(elem); return new Vec<T>(new Uint8Array(Math.max(capacity, 4) * c.z) as Buf<T>, elem, c); }
    return new Vec<T>(new TYPED[elem as NumType](Math.max(capacity, 4)), elem);
  }
  /** A Vec made where its element type was a type parameter ("other") switches to the representation of `elem` (C boundary, D105). */
  adopt(elem: ElemKind): void {
    if (this.elem !== "other" || elem === "other") return;
    const xs = (this.buf as T[]).slice(0, this.len), v = Vec.create<T>(undefined, xs.length, elem);
    for (const x of xs) v.push(x);
    this.buf = v.buf; this.elem = elem; this.cod = v.cod;
  }
  /** C boundary growth (D106): a bigger buffer of the same representation holding the first `len` elements. Allocation failure throws RangeError (T006). */
  reserve(cap: number, len: number): void {
    const z = this.cod ? this.cod.z : 1;
    const bigger = this.cod ? new Uint8Array(cap * z) : new TYPED[this.elem as NumType](cap);
    bigger.set((this.buf as Uint8Array).subarray(0, len * z) as never);
    this.buf = bigger as Buf<T>;
  }
  get length(): number { return this.len; }
  get(i: number, pos?: Pos): T {
    if (!inBounds(i, this.len)) trap("T002", `index ${i} out of range (length ${this.len})`, pos);
    if (this.cod) return this.cod.rd(dvOf(this.buf as Uint8Array), i * this.cod.z) as T;
    return this.buf[i] as T;
  }
  set(i: number, x: T, pos?: Pos): void {
    if (!inBounds(i, this.len)) trap("T002", `index ${i} out of range (length ${this.len})`, pos);
    if (this.cod) this.cod.wr(dvOf(this.buf as Uint8Array), i * this.cod.z, x);
    else (this.buf as T[])[i] = x;
  }
  push(x: T): void {
    const c = this.cod;
    if (c) {
      if ((this.len + 1) * c.z > this.buf.length) { const bigger = new Uint8Array(this.len * 2 * c.z); bigger.set(this.buf as Uint8Array); this.buf = bigger as Buf<T>; }
      this.len++;
      this.set(this.len - 1, x);
      return;
    }
    if (this.elem !== "other" && this.len === this.buf.length) {
      const bigger = new TYPED[this.elem as NumType](this.len * 2);
      bigger.set(this.buf as Float64Array);
      this.buf = bigger as Buf<T>;
    }
    (this.buf as T[])[this.len++] = x;
  }
  pop(): T | null {
    if (this.len === 0) return null;
    const x = this.get(this.len - 1);
    this.len--;
    return x;
  }
  clear(): void { this.len = 0; }
  fill(x: T): void {
    if (this.cod) for (let i = 0; i < this.len; i++) this.set(i, x);
    else (this.buf as T[]).fill(x, 0, this.len);
  }
  slice(start: number, end: number, pos?: Pos): Slice<T> {
    if (!(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start <= end && end <= this.len))
      trap("T002", `slice ${start}..${end} out of range (length ${this.len})`, pos);
    return new Slice(this.buf, start, end - start, this.cod, this);
  }
  /** Whole-vector view, for passing a Vec where a Slice parameter is expected. */
  view(): Slice<T> { return new Slice(this.buf, 0, this.len, this.cod, this); }
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

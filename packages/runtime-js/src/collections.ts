import { trap, type Pos, type TrapCode } from "./trap.ts";
import type { NumType } from "./num.ts";

const inBounds = (i: number, len: number): boolean => Number.isInteger(i) && i >= 0 && i < len;

type Buf<T> = T[] | Float64Array | Float32Array | Int8Array | Int16Array | Int32Array | Uint8Array | Uint16Array | Uint32Array | BigInt64Array | BigUint64Array;
export type TypedArray = Exclude<Buf<never>, never[]>;
type TypedCtor = new (n: number) => TypedArray;
const TYPED: Record<NumType, TypedCtor> = {
  i8: Int8Array, i16: Int16Array, i32: Int32Array, i64: BigInt64Array,
  u8: Uint8Array, u16: Uint16Array, u32: Uint32Array, u64: BigUint64Array,
  usize: Uint32Array, f32: Float32Array, f64: Float64Array,
};
/** Element kind the translator passes to Vec.create: a number type, the JSON of a byte layout (SPEC §10.2, D105), or "other" for a plain array. */
export type ElemKind = NumType | "other" | `{${string}`;

type Lay =
  | { t: "num"; n: NumType; z: number } | { t: "bool"; z: number } | { t: "null"; z: number } | { t: "lit"; v: string[]; z: number }
  | { t: "rec"; f: { n: string; o: number; l: Lay }[]; z: number } | { t: "uni"; m: Lay[]; z: number } | { t: "opt"; o: number; l: Lay; z: number }
  | { t: "hdl"; z: number } | { t: "abuf"; z: number };
interface Codec { readonly z: number; rd(d: DataView, p: number): unknown; wr(d: DataView, p: number, x: unknown): void }
const LE = true;
const NUM_RW: Record<NumType, [(d: DataView, p: number) => number | bigint, (d: DataView, p: number, x: number | bigint) => void]> = {
  i8: [(d, p) => d.getInt8(p), (d, p, x) => d.setInt8(p, x as number)], u8: [(d, p) => d.getUint8(p), (d, p, x) => d.setUint8(p, x as number)],
  i16: [(d, p) => d.getInt16(p, LE), (d, p, x) => d.setInt16(p, x as number, LE)], u16: [(d, p) => d.getUint16(p, LE), (d, p, x) => d.setUint16(p, x as number, LE)],
  i32: [(d, p) => d.getInt32(p, LE), (d, p, x) => d.setInt32(p, x as number, LE)], u32: [(d, p) => d.getUint32(p, LE), (d, p, x) => d.setUint32(p, x as number, LE)],
  i64: [(d, p) => d.getBigInt64(p, LE), (d, p, x) => d.setBigInt64(p, x as bigint, LE)], u64: [(d, p) => d.getBigUint64(p, LE), (d, p, x) => d.setBigUint64(p, x as bigint, LE)],
  usize: [(d, p) => d.getUint32(p, LE), (d, p, x) => d.setUint32(p, x as number, LE)],
  f32: [(d, p) => d.getFloat32(p, LE), (d, p, x) => d.setFloat32(p, x as number, LE)], f64: [(d, p) => d.getFloat64(p, LE), (d, p, x) => d.setFloat64(p, x as number, LE)],
};
function codec(l: Lay): Codec {
  switch (l.t) {
    case "num": { const [rd, wr] = NUM_RW[l.n]; return { z: l.z, rd, wr: wr as Codec["wr"] }; }
    case "bool": return { z: 1, rd: (d, p) => d.getUint8(p) !== 0, wr: (d, p, x) => d.setUint8(p, x ? 1 : 0) };
    case "null": return { z: 1, rd: () => null, wr: (d, p) => { d.setUint8(p, 0); } };
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
    case "hdl": // Q188 (a): a Pool handle is three u32s (pool id, generation, index)
      return {
        z: 12,
        rd: (d, p) => ({ pool: d.getUint32(p, LE), gen: d.getUint32(p + 4, LE), idx: d.getUint32(p + 8, LE) }),
        wr: (d, p, x) => { const h = x as PoolHandle; d.setUint32(p, h.pool, LE); d.setUint32(p + 4, h.gen, LE); d.setUint32(p + 8, h.idx, LE); },
      };
    case "abuf": // Q188 (b): an ArenaBuf is four u32s (arena id, generation, head byte position, length)
      return {
        z: 16,
        rd: (d, p) => ({ arena: d.getUint32(p, LE), gen: d.getUint32(p + 4, LE), off: d.getUint32(p + 8, LE), length: d.getUint32(p + 12, LE) }),
        wr: (d, p, x) => { const b = x as ArenaBuf; d.setUint32(p, b.arena, LE); d.setUint32(p + 4, b.gen, LE); d.setUint32(p + 8, b.off, LE); d.setUint32(p + 12, b.length, LE); },
      };
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
  /** Extra byte offset of element 0, for a packed view whose head is not a multiple of the element size (Arena, Q188 (b)). */
  private readonly boff: number;
  /** Byte range within a root allocation, for the T013 check across element types (Arena views, Q188 (b)). */
  readonly span: { root: object; lo: number; hi: number; z: number } | undefined;
  constructor(buf: Buf<T>, off: number, length: number, cod?: Codec, owner?: Vec<T>, boff = 0, span?: { root: object; lo: number; hi: number; z: number }) { this.buf = buf; this.off = off; this.length = length; this.cod = cod; this.owner = owner; this.boff = boff; this.span = span; }
  /** C boundary: a view of a Vec made with a type parameter as its element type ("other") adopts `elem` together with that Vec. */
  adopt(elem: ElemKind): void {
    if (!this.owner || !Array.isArray(this.buf)) return;
    this.owner.adopt(elem);
    const o = this.owner as unknown as { buf: Buf<T>; cod: Codec | undefined };
    this.buf = o.buf; this.cod = o.cod;
  }
  get(i: number, pos?: Pos): T {
    if (!inBounds(i, this.length)) trap("T002", `index ${i} out of range (length ${this.length})`, pos);
    if (this.cod) return this.cod.rd(dvOf(this.buf as Uint8Array), this.boff + (this.off + i) * this.cod.z) as T;
    return this.buf[this.off + i] as T;
  }
  set(i: number, x: T, pos?: Pos): void {
    if (!inBounds(i, this.length)) trap("T002", `index ${i} out of range (length ${this.length})`, pos);
    if (this.cod) this.cod.wr(dvOf(this.buf as Uint8Array), this.boff + (this.off + i) * this.cod.z, x);
    else (this.buf as T[])[this.off + i] = x;
  }
  fill(x: T): void {
    if (this.cod) for (let i = 0; i < this.length; i++) this.set(i, x);
    else (this.buf as T[]).fill(x, this.off, this.off + this.length);
  }
  slice(start: number, end: number, pos?: Pos): Slice<T> {
    if (!(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start <= end && end <= this.length))
      trap("T002", `slice ${start}..${end} out of range (length ${this.length})`, pos);
    const span = this.span ? { root: this.span.root, lo: this.span.lo + start * this.span.z, hi: this.span.lo + end * this.span.z, z: this.span.z } : undefined;
    return new Slice(this.buf, this.off + start, end - start, this.cod, this.owner, this.boff, span);
  }
  /** Q190 (b): same underlying Vec (or, failing that, same buffer) and overlapping element ranges; a zero-length range overlaps nothing. Element ranges stand in for byte ranges: one root has one element size. */
  overlaps(o: Slice<T>): boolean {
    if (this.span && o.span) return this.span.root === o.span.root && Math.max(this.span.lo, o.span.lo) < Math.min(this.span.hi, o.span.hi);
    if (this.span || o.span) return false; // a byte view and a value view never share an allocation
    const a: object = this.owner ?? this.buf;
    const b: object = o.owner ?? o.buf;
    return a === b && Math.max(this.off, o.off) < Math.min(this.off + this.length, o.off + o.length);
  }
  /** Internal host helper for `Fs.writeBytes`. */
  readBytes(): Uint8Array {
    if (this.buf instanceof Uint8Array && !this.cod) return this.buf.subarray(this.off, this.off + this.length);
    const out = new Uint8Array(this.length);
    for (let i = 0; i < this.length; i++) out[i] = Number(this.get(i));
    return out;
  }
}

/**
 * Q190 (b): after every argument of a call has been evaluated, the same-root `slice` arguments of one call
 * must not overlap when at least one of a pair is `Mut` (T013). Entries are in evaluation order; the trap
 * position is the first entry that overlaps an earlier one.
 */
export function checkSlices(entries: readonly (readonly [Slice, boolean, Pos?])[]): void {
  for (let j = 1; j < entries.length; j++) {
    const [b, bm, bp] = entries[j]!;
    for (let i = 0; i < j; i++) {
      const [a, am] = entries[i]!;
      if ((am || bm) && a.overlaps(b)) trap("T013", "overlapping slices passed to one call", bp);
    }
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
  static filled<T>(_alloc: unknown, length: number, init: T, elem: ElemKind = "other"): Vec<T> {
    if (elem === "other") {
      const v = new Vec<T>(new Array<T>(length).fill(init), elem);
      v.len = length;
      return v;
    }
    const v = Vec.create<T>(_alloc, length, elem);
    v.len = length;
    v.fill(init);
    return v;
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
      if ((this.len + 1) * c.z > this.buf.length) { const bigger = new Uint8Array(Math.max(this.len * 2, 4) * c.z); bigger.set(this.buf as Uint8Array); this.buf = bigger as Buf<T>; }
      this.len++;
      this.set(this.len - 1, x);
      return;
    }
    if (this.elem !== "other" && this.len === this.buf.length) {
      const bigger = new TYPED[this.elem as NumType](Math.max(this.len * 2, 4)); // an unpacked empty Vec has a 0-length buffer (§15.2)
      bigger.set(this.buf as never);
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
  /** JS host interop (`--mode=lib`): zero-copy view of the live `0..length` elements of a numeric `Vec`. Detached if the `Vec` later reallocates. */
  asTypedArray(): TypedArray {
    if (this.elem === "other" || this.cod) throw new TypeError(`Vec.asTypedArray() requires a numeric Vec (got '${this.elem}')`);
    return (this.buf as Uint8Array).subarray(0, this.len) as unknown as TypedArray;
  }
  /** JS host interop (`--mode=lib`): creates a numeric `Vec` from a TypedArray or array-like in one bulk copy. */
  static fromTypedArray<T>(_alloc: unknown, src: ArrayLike<number | bigint>, elem: NumType): Vec<T> {
    const Ctor = Object.hasOwn(TYPED, elem) ? TYPED[elem] : undefined;
    if (!Ctor) throw new TypeError(`Vec.fromTypedArray() requires a numeric element type (got '${String(elem)}')`);
    const n = src.length;
    const buf = new Ctor(Math.max(n, 4));
    if (elem === "i64" || elem === "u64") {
      const b = buf as BigInt64Array | BigUint64Array;
      if (src instanceof BigInt64Array || src instanceof BigUint64Array) b.set(src as never);
      else for (let i = 0; i < n; i++) b[i] = BigInt(src[i]!);
    } else {
      (buf as Uint8Array).set(src as ArrayLike<number>);
    }
    const v = new Vec<T>(buf as Buf<T>, elem);
    v.len = n;
    return v;
  }
  /** §15.2: the wire form for an isolate boundary. Numeric / packed storage crosses as an exact-length
   * ArrayBuffer (the channel transfers it, so the region moves); "other" storage as its items. */
  pack(): { elem: ElemKind; buf?: ArrayBuffer; items?: unknown[] } {
    if (this.elem === "other") return { elem: this.elem, items: (this.buf as T[]).slice(0, this.len) };
    const live = this.cod
      ? (this.buf as Uint8Array).subarray(0, this.len * this.cod.z)
      : new Uint8Array((this.buf as ArrayBufferView).buffer, (this.buf as ArrayBufferView).byteOffset, this.len * (this.buf as unknown as { BYTES_PER_ELEMENT: number }).BYTES_PER_ELEMENT);
    const buf = new ArrayBuffer(live.byteLength);
    new Uint8Array(buf).set(live);
    return { elem: this.elem, buf };
  }
  static unpack<T>(w: { elem: ElemKind; buf?: ArrayBuffer; items?: unknown[] }): Vec<T> {
    if (w.elem === "other") { const v = new Vec<T>(w.items!.slice() as T[], w.elem); v.len = w.items!.length; return v; }
    if (w.elem.startsWith("{")) { const c = codecOf(w.elem); const v = new Vec<T>(new Uint8Array(w.buf!), w.elem, c); v.len = w.buf!.byteLength / c.z; return v; }
    const ta = new (TYPED[w.elem as NumType] as unknown as new (b: ArrayBuffer) => ArrayBufferView)(w.buf!);
    const v = new Vec<T>(ta as Buf<T>, w.elem);
    v.len = w.buf!.byteLength / (ta as unknown as { BYTES_PER_ELEMENT: number }).BYTES_PER_ELEMENT;
    return v;
  }
  /** Internal host helper for `Fs.writeBytes`. */
  readBytes(): Uint8Array {
    if (this.elem === "u8") return (this.buf as Uint8Array).subarray(0, this.len);
    const out = new Uint8Array(this.len);
    for (let i = 0; i < this.len; i++) out[i] = Number(this.get(i));
    return out;
  }
  /** Internal host helper for `Fs.readBytes`. */
  replaceBytes(bytes: Uint8Array): void {
    if (this.elem === "other") this.adopt("u8");
    const n = bytes.length;
    if ((this.buf as Uint8Array).length < n) this.buf = new Uint8Array(Math.max(n, 4)) as Buf<T>;
    (this.buf as Uint8Array).set(bytes);
    this.len = n;
  }
}

/** Internal host helper for `Fs.writeBytes` (not exposed in compiler builtins). */
export function readU8Slice(src: Vec<number> | Slice<number>): Uint8Array {
  return src instanceof Slice ? src.readBytes() : src.readBytes();
}
/** Internal host helper for `Fs.readBytes` (not exposed in compiler builtins). */
export function replaceU8Vec(dst: Vec<number>, bytes: Uint8Array): void {
  dst.replaceBytes(bytes);
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

/** A Pool handle (Q188 (a)): pool id, generation, slot index. A plain object; Szigyr code cannot see the fields. */
export interface PoolHandle { pool: number; gen: number; idx: number }
/** Value equality for Handle<T> / Handle<T> | null (SPEC-v1 §3.4). */
export const handleEq = (a: PoolHandle | null, b: PoolHandle | null): boolean =>
  a === b || (a !== null && b !== null && a.pool === b.pool && a.gen === b.gen && a.idx === b.idx);

/** Process-unique Pool and Arena ids via shared Atomics counter when available, else unique prefix per worker. */
let idSab: SharedArrayBuffer | null = typeof SharedArrayBuffer !== "undefined" ? new SharedArrayBuffer(4) : null;
let idView: Int32Array | null = idSab ? new Int32Array(idSab) : null;
if (idView) Atomics.store(idView, 0, 1);
let idPrefix = 0;
let nextLocalId = 1;
export const getHostIdSab = (): SharedArrayBuffer | null => idSab;
export function initHostIds(sab: SharedArrayBuffer | null | undefined, prefix = 0): void {
  if (sab) { idSab = sab; idView = new Int32Array(sab); }
  else { idSab = null; idView = null; }
  idPrefix = prefix;
}
function allocHostId(): number {
  if (idView) {
    let id = Atomics.add(idView, 0, 1) >>> 0;
    if (id === 0) id = Atomics.add(idView, 0, 1) >>> 0;
    return id;
  }
  const seq = nextLocalId++ & 0xfffff;
  return (((idPrefix & 0xfff) << 20) | (seq || 1)) >>> 0;
}
function copyBuf(v: ArrayBufferView): ArrayBuffer {
  const out = new ArrayBuffer(v.byteLength);
  new Uint8Array(out).set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
  return out;
}

export interface PoolWire {
  id: number; cap: number; elem: ElemKind; len: number; freeHead: number; nextFresh: number;
  gens: ArrayBuffer; occ: ArrayBuffer; nextFree: ArrayBuffer; buf?: ArrayBuffer; items?: unknown[];
}

/**
 * Fixed-capacity pool (Q188 (a)). Storage mirrors Vec (a TypedArray, a packed Uint8Array, or a plain
 * array for a type-parameter element). Slots are used in increasing index order first; removed slots are
 * reused last-in-first-out, bumping the slot's generation (a u32, wrapping to 0) on each reuse.
 */
export class Pool<T = unknown> {
  private buf: Buf<T>;
  private elem: ElemKind;
  private cod: Codec | undefined;
  readonly id: number;
  private gens: Uint32Array;
  private occ: Uint8Array;
  private nextFree: Int32Array;
  private len = 0;
  private freeHead = -1;
  private nextFresh = 0;
  private readonly cap: number;
  private constructor(buf: Buf<T>, elem: ElemKind, cap: number, cod?: Codec, id?: number) {
    this.buf = buf; this.elem = elem; this.cap = cap; this.cod = cod;
    this.id = id ?? allocHostId();
    this.gens = new Uint32Array(cap); this.occ = new Uint8Array(cap); this.nextFree = new Int32Array(cap);
  }
  pack(): PoolWire {
    return {
      id: this.id, cap: this.cap, elem: this.elem, len: this.len, freeHead: this.freeHead, nextFresh: this.nextFresh,
      gens: copyBuf(this.gens), occ: copyBuf(this.occ), nextFree: copyBuf(this.nextFree),
      ...(this.elem === "other" ? { items: (this.buf as T[]).slice() } : { buf: copyBuf(this.buf as ArrayBufferView) }),
    };
  }
  static unpack<T>(w: PoolWire): Pool<T> {
    let buf: Buf<T>; let cod: Codec | undefined;
    if (w.elem === "other") buf = w.items!.slice() as T[];
    else if (w.elem.startsWith("{")) { cod = codecOf(w.elem); buf = new Uint8Array(w.buf!) as Buf<T>; }
    else buf = new (TYPED[w.elem as NumType] as unknown as new (b: ArrayBuffer) => Buf<T>)(w.buf!);
    const p = new Pool<T>(buf, w.elem, w.cap, cod, w.id);
    p.gens = new Uint32Array(w.gens);
    p.occ = new Uint8Array(w.occ);
    p.nextFree = new Int32Array(w.nextFree);
    p.len = w.len; p.freeHead = w.freeHead; p.nextFresh = w.nextFresh;
    return p;
  }
  /** `alloc` is accepted for the signature only. The capacity is fixed: the pool never grows. */
  static create<T>(_alloc: unknown, capacity: number, elem: ElemKind = "other"): Pool<T> {
    if (elem === "other") return new Pool<T>(new Array(capacity) as Buf<T>, elem, capacity);
    if (elem.startsWith("{")) { const c = codecOf(elem); return new Pool<T>(new Uint8Array(capacity * c.z) as Buf<T>, elem, capacity, c); }
    return new Pool<T>(new TYPED[elem as NumType](capacity), elem, capacity);
  }
  /** A Pool made where its element type was a type parameter ("other") switches to the representation of `elem` (C boundary, like Vec.adopt). */
  adopt(elem: ElemKind): void {
    if (this.elem !== "other" || elem === "other") return;
    const old = this.buf as T[];
    if (elem.startsWith("{")) { this.cod = codecOf(elem); this.buf = new Uint8Array(this.cap * this.cod.z) as Buf<T>; }
    else this.buf = new TYPED[elem as NumType](this.cap);
    this.elem = elem;
    for (let i = 0; i < this.cap; i++) if (this.occ[i]) this.write(i, old[i]!);
  }
  get length(): number { return this.len; }
  get capacity(): number { return this.cap; }
  private read(i: number): T {
    if (this.cod) return this.cod.rd(dvOf(this.buf as Uint8Array), i * this.cod.z) as T;
    return this.buf[i] as T;
  }
  private write(i: number, x: T): void {
    if (this.cod) this.cod.wr(dvOf(this.buf as Uint8Array), i * this.cod.z, x);
    else (this.buf as T[])[i] = x;
  }
  private valid(h: PoolHandle): boolean {
    return !!h && h.pool === this.id && Number.isInteger(h.idx) && h.idx >= 0 && h.idx < this.cap && this.occ[h.idx] === 1 && this.gens[h.idx] === h.gen;
  }
  insert(x: T): PoolHandle | null {
    if (this.len >= this.cap) return null;
    let idx: number;
    if (this.freeHead >= 0) {
      idx = this.freeHead;
      this.freeHead = this.nextFree[idx]!;
      this.gens[idx] = (this.gens[idx]! + 1) >>> 0; // a reused slot's generation bumps (wraps to 0)
    } else idx = this.nextFresh++;
    this.occ[idx] = 1;
    this.write(idx, x);
    this.len++;
    return { pool: this.id, gen: this.gens[idx]!, idx };
  }
  get(h: PoolHandle, pos?: Pos): T {
    if (!this.valid(h)) trap("T011", "invalid pool handle", pos);
    return this.read(h.idx);
  }
  set(h: PoolHandle, x: T, pos?: Pos): void {
    if (!this.valid(h)) trap("T011", "invalid pool handle", pos);
    this.write(h.idx, x);
  }
  remove(h: PoolHandle, pos?: Pos): T {
    if (!this.valid(h)) trap("T011", "invalid pool handle", pos);
    const x = this.read(h.idx);
    this.occ[h.idx] = 0;
    this.nextFree[h.idx] = this.freeHead;
    this.freeHead = h.idx;
    this.len--;
    return x;
  }
  has(h: PoolHandle): boolean { return this.valid(h); }
}

/** An ArenaBuf handle (Q188 (b)): arena id, generation, head byte position, element count. A plain object; Szigyr code sees only `length`. */
export interface ArenaBuf { arena: number; gen: number; off: number; length: number }

const NUM_SIZE: Record<string, number> = { i8: 1, u8: 1, i16: 2, u16: 2, i32: 4, u32: 4, i64: 8, u64: 8, usize: 4, f32: 4, f64: 8 };
type TypedView = { [i: number]: number | bigint; fill(v: never): void };
const typedView = (elem: string, buf: Uint8Array, off: number, n: number): TypedView =>
  new (TYPED[elem as NumType] as unknown as new (b: ArrayBufferLike, o: number, n: number) => TypedView)(buf.buffer, off, n);

/**
 * A bump arena over one host ArrayBuffer (Q188 (b), D102). Allocations are byte ranges handed out in
 * order; `reset` bumps the generation (a u32, wrapping) and rewinds. An allocation whose element type
 * has no byte layout ("other": `null`, `Result<null, i32>`, Q229; a type parameter is rejected at compile time, Q215 (c)) keeps
 * its values in a side array. A type-parameter `view` of any other allocation reads and writes the
 * bytes through the element type recorded at `alloc` (or by `noteC`), so it never goes stale (D131).
 * The fields `buf` / `used` / `gen` / `id` are read and written back by the C backend, like Pool's.
 */
export interface ArenaWire {
  id: number; buf: ArrayBuffer; used: number; gen: number;
  recs: [number, { elem: ElemKind; arr: unknown[] | null }][];
}

export class Arena {
  readonly id: number;
  private buf: Uint8Array;
  private used = 0;
  private gen = 0;
  private recs = new Map<number, { elem: ElemKind; arr: unknown[] | null }>();
  private constructor(bytes: number, id?: number) { this.id = id ?? allocHostId(); this.buf = new Uint8Array(bytes); }
  pack(): ArenaWire {
    return {
      id: this.id, buf: copyBuf(this.buf), used: this.used, gen: this.gen,
      recs: [...this.recs.entries()].map(([k, r]) => [k, { elem: r.elem, arr: r.arr ? r.arr.slice() : null }]),
    };
  }
  static unpack(w: ArenaWire): Arena {
    const a = new Arena(0, w.id);
    a.buf = new Uint8Array(w.buf);
    a.used = w.used; a.gen = w.gen;
    a.recs = new Map(w.recs.map(([k, r]) => [k, { elem: r.elem, arr: r.arr ? r.arr.slice() : null }]));
    return a;
  }
  /** `alloc` is accepted for the signature only: the region is one ArrayBuffer of `bytes` bytes. */
  static create(_alloc: unknown, bytes: number): Arena { return new Arena(bytes); }
  get remaining(): number { return this.buf.length - this.used; }
  private sizeOf(elem: ElemKind): { z: number; a: number } {
    if (elem === "other") return { z: 8, a: 8 }; // nominal: only an element type without a byte layout gets here (`null` etc., Q229; Q215 (c))
    if (elem.startsWith("{")) { const l = JSON.parse(elem) as { z: number; a: number }; return { z: l.z, a: l.a }; }
    const z = NUM_SIZE[elem]!; return { z, a: z };
  }
  alloc<T>(n: number, init: T, elem: ElemKind = "other"): ArenaBuf | null {
    const { z, a } = this.sizeOf(elem);
    const off = Math.ceil(this.used / a) * a;
    if (off + n * z > this.buf.length) return null;
    this.used = off + n * z;
    const b: ArenaBuf = { arena: this.id, gen: this.gen, off, length: n };
    this.recs.set(off, { elem, arr: elem === "other" ? new Array(n).fill(init) : null });
    if (elem.startsWith("{")) { const c = codecOf(elem), d = dvOf(this.buf); for (let i = 0; i < n; i++) c.wr(d, off + i * z, init); }
    else if (elem !== "other") typedView(elem, this.buf, off, n).fill(init as never);
    return b;
  }
  /** C boundary: a buf the C side allocated at `off`; its values live in the bytes as `elem` (read back by a type-parameter view). */
  noteC(off: number, elem: ElemKind): void { this.recs.set(off, { elem, arr: null }); }
  view<T>(b: ArenaBuf, elem: ElemKind = "other", pos?: Pos): Slice<T> {
    if (!b || b.arena !== this.id || b.gen !== this.gen) trap("T012", "invalid ArenaBuf", pos);
    const rec = this.recs.get(b.off);
    if (elem === "other" && rec && rec.elem !== "other") elem = rec.elem; // a type-parameter view reads the bytes directly, so C writes stay visible (D129, D131)
    if (elem === "other") return new Slice((rec?.arr ?? new Array(b.length)) as T[], 0, b.length); // an element without a byte layout (Q229)
    const { z } = this.sizeOf(elem);
    const span = { root: this as object, lo: b.off, hi: b.off + b.length * z, z };
    if (elem.startsWith("{")) return new Slice(this.buf as unknown as Buf<T>, 0, b.length, codecOf(elem), undefined, b.off, span);
    return new Slice(typedView(elem, this.buf, b.off, b.length) as unknown as Buf<T>, 0, b.length, undefined, undefined, 0, span);
  }
  reset(): void {
    this.gen = (this.gen + 1) >>> 0; // wraps to 0, like a Pool slot generation (Q188 (a))
    this.used = 0;
    this.recs.clear();
  }
}


/**
 * SPSC ring buffer (SPEC 15.1, Q199). The storage is one SharedArrayBuffer: the head (read) and
 * tail (write) positions are monotonic u32 counters at bytes 0 and 4, read and written with
 * acquire / release ordering (Atomics here, C11 atomics in the C backend, D122), and the elements
 * sit at byte 8 in the 10.2 layout, the slot of counter c being c & (capacity - 1). No state lives
 * outside the buffer, so the endpoints work from any thread, and either side being dropped leaves
 * the other usable. A ring whose element type is a type parameter ("other") keeps its values in a
 * plain queue until the C boundary adopts a concrete representation, like Vec (D105).
 */
const RING_ELEMS = 8; // bytes 0..3: head, 4..7: tail
const isSab = (b: ArrayBufferLike): boolean => typeof SharedArrayBuffer !== "undefined" && b instanceof SharedArrayBuffer;
export interface RingShared<T> {
  sab: ArrayBufferLike | null;
  atomic: boolean;
  cap: number;
  elem: ElemKind;
  cod: Codec | undefined;
  view: TypedView | undefined; // numeric elements, over the buffer
  dv: DataView | undefined;
  pos: Uint32Array | undefined; // [head, tail] over the buffer
  queue: T[]; // "other" mode only
  onPush?: (bytes: Uint8Array) => void;
}
function ringAttach<T>(s: RingShared<T>, sab: ArrayBufferLike, elem: ElemKind): void {
  s.sab = sab;
  s.atomic = isSab(sab);
  s.elem = elem;
  s.cod = elem.startsWith("{") ? codecOf(elem) : undefined;
  s.dv = new DataView(sab);
  s.pos = new Uint32Array(sab, 0, 2);
  s.view = s.cod ? undefined : new (TYPED[elem as NumType] as unknown as new (b: ArrayBufferLike, o: number, n: number) => TypedView)(sab, RING_ELEMS, s.cap);
}
function ringWrite<T>(s: RingShared<T>, slot: number, x: T): void {
  if (s.cod) s.cod.wr(s.dv!, RING_ELEMS + slot * s.cod.z, x);
  else s.view![slot] = x as number | bigint;
}
function ringRead<T>(s: RingShared<T>, slot: number): T {
  if (s.cod) return s.cod.rd(s.dv!, RING_ELEMS + slot * s.cod.z) as T;
  return s.view![slot] as T;
}
function ringAlloc<T>(cap: number, elem: ElemKind): ArrayBufferLike {
  const z = elem.startsWith("{") ? codecOf(elem).z : NUM_SIZE[elem]!;
  const bytes = RING_ELEMS + cap * z;
  return typeof SharedArrayBuffer !== "undefined" ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes);
}
/** A ring made where its element type was a type parameter switches to the representation of `elem` (C boundary, D105); the queued values move in. */
function ringAdopt<T>(s: RingShared<T>, elem: ElemKind): void {
  if (s.sab || elem === "other") return;
  ringAttach(s, ringAlloc(s.cap, elem), elem);
  for (let i = 0; i < s.queue.length; i++) ringWrite(s, i, s.queue[i]!);
  if (s.atomic) Atomics.store(s.pos!, 1, s.queue.length);
  else s.pos![1] = s.queue.length;
  s.queue = [];
}

/** Appends one pre-encoded element (for MessagePort fallback when SharedArrayBuffer is unavailable). */
export function ringPushRaw(s: RingShared<unknown>, bytes: Uint8Array): boolean {
  if (!s.sab || !s.pos) return false;
  const tail = s.atomic ? Atomics.load(s.pos, 1) : s.pos[1]!;
  const head = s.atomic ? Atomics.load(s.pos, 0) : s.pos[0]!;
  if (((tail - head) >>> 0) >= s.cap) return false;
  const z = bytes.byteLength;
  const off = RING_ELEMS + (tail & (s.cap - 1)) * z;
  new Uint8Array(s.sab, off, z).set(bytes);
  if (s.atomic) Atomics.store(s.pos, 1, (tail + 1) >>> 0);
  else s.pos[1] = (tail + 1) >>> 0;
  return true;
}

export class RingTx<T = unknown> {
  private s: RingShared<T>;
  constructor(s: RingShared<T>) { this.s = s; }
  /** The shared state itself, for the isolate transport (§15.2). */
  get shared(): RingShared<T> { return this.s; }
  /** The buffer the C backend works on (sz_ring_in); null until a type-parameter element adopts one. */
  get sab(): ArrayBufferLike | null { return this.s.sab; }
  /** The capacity the C backend reads (sz_ring_in). */
  get cap(): number { return this.s.cap; }
  /** C boundary: switch a type-parameter element to its concrete representation (like Vec.adopt). */
  adopt(elem: ElemKind): void { ringAdopt(this.s, elem); }
  push(x: T): boolean {
    const s = this.s;
    if (!s.sab) {
      if (s.queue.length >= s.cap) return false;
      s.queue.push(x);
      return true;
    }
    const tail = s.atomic ? Atomics.load(s.pos!, 1) : s.pos![1]!;
    const head = s.atomic ? Atomics.load(s.pos!, 0) : s.pos![0]!;
    if (((tail - head) >>> 0) >= s.cap) return false; // full, as far as this side can see (15.1)
    const slot = tail & (s.cap - 1);
    ringWrite(s, slot, x);
    if (s.atomic) Atomics.store(s.pos!, 1, (tail + 1) >>> 0); // release: the element write above is visible first
    else {
      s.pos![1] = (tail + 1) >>> 0;
      if (s.onPush) {
        const z = s.cod ? s.cod.z : NUM_SIZE[s.elem as NumType]!;
        s.onPush(new Uint8Array(s.sab, RING_ELEMS + slot * z, z).slice());
      }
    }
    return true;
  }
}

export class RingRx<T = unknown> {
  private s: RingShared<T>;
  constructor(s: RingShared<T>) { this.s = s; }
  /** The shared state itself, for the isolate transport (§15.2). */
  get shared(): RingShared<T> { return this.s; }
  /** The buffer the C backend works on (sz_ring_in); null until a type-parameter element adopts one. */
  get sab(): ArrayBufferLike | null { return this.s.sab; }
  /** The capacity the C backend reads (sz_ring_in). */
  get cap(): number { return this.s.cap; }
  /** C boundary: switch a type-parameter element to its concrete representation (like Vec.adopt). */
  adopt(elem: ElemKind): void { ringAdopt(this.s, elem); }
  pop(): T | null {
    const s = this.s;
    if (!s.sab) return s.queue.length ? s.queue.shift()! : null;
    const head = s.atomic ? Atomics.load(s.pos!, 0) : s.pos![0]!;
    const tail = s.atomic ? Atomics.load(s.pos!, 1) : s.pos![1]!;
    if (head === tail) return null; // empty, as far as this side can see (15.1)
    const x = ringRead(s, head & (s.cap - 1));
    if (s.atomic) Atomics.store(s.pos!, 0, (head + 1) >>> 0); // release: the slot is free for the writer
    else s.pos![0] = (head + 1) >>> 0;
    return x;
  }
}

export class Ring {
  /** `alloc` is accepted for the signature only. The capacity is fixed and must be a power of two. */
  static create<T>(_alloc: unknown, capacity: number, elem: ElemKind = "other", pos?: Pos): { tx: RingTx<T>; rx: RingRx<T> } {
    if (!Number.isInteger(capacity) || capacity <= 0 || capacity > 2 ** 31 || (capacity & (capacity - 1)) !== 0)
      trap("T014", `invalid ring capacity ${capacity}`, pos);
    const s: RingShared<T> = { sab: null, atomic: false, cap: capacity, elem, cod: undefined, view: undefined, dv: undefined, pos: undefined, queue: [] };
    if (elem !== "other") ringAttach(s, ringAlloc(capacity, elem), elem);
    return { tx: new RingTx<T>(s), rx: new RingRx<T>(s) };
  }
  /** Endpoints over an existing buffer (the two-Worker test; the isolate transport is 15.2's). */
  static fromShared<T>(sab: ArrayBufferLike, capacity: number, elem: ElemKind): { tx: RingTx<T>; rx: RingRx<T> } {
    const s: RingShared<T> = { sab: null, atomic: false, cap: capacity, elem, cod: undefined, view: undefined, dv: undefined, pos: undefined, queue: [] };
    ringAttach(s, sab, elem);
    return { tx: new RingTx<T>(s), rx: new RingRx<T>(s) };
  }
}

/** §15.2: the wire form of a ring's shared state. With a buffer, the far side's endpoints attach to
 * the same SharedArrayBuffer; in queue mode ("other" elements, no buffer yet) the buffered items move. */
export interface RingWire { sab: ArrayBufferLike | null; cap: number; elem: ElemKind; queue: unknown[] }
export function ringPack<T>(s: RingShared<T>): RingWire {
  return { sab: s.sab, cap: s.cap, elem: s.elem, queue: s.sab ? [] : (s.queue.splice(0) as unknown[]) };
}
export function ringUnpack(w: RingWire): RingShared<unknown> {
  const s: RingShared<unknown> = { sab: null, atomic: false, cap: w.cap, elem: w.elem, cod: undefined, view: undefined, dv: undefined, pos: undefined, queue: w.queue.slice() };
  if (w.sab) ringAttach(s, w.sab, w.elem);
  return s;
}

export class OwnedCell<T> {
  private value: T | undefined;
  private full: boolean;
  private readers = 0;
  private mutBorrowed = false;
  private constructor(value: T | undefined, full: boolean) { this.value = value; this.full = full; }
  static create<T>(v: T): OwnedCell<T> { return new OwnedCell<T>(v, true); }
  take(pos?: Pos): T {
    if (!this.full) trap("T008", "take from empty OwnedCell", pos);
    if (this.mutBorrowed || this.readers > 0) trap("T008", "take from borrowed OwnedCell", pos);
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
  withRef<R>(f: (v: T) => R, pos?: Pos): R {
    if (!this.full) trap("T008", "withRef on empty OwnedCell", pos);
    if (this.mutBorrowed) trap("T008", "withRef on mutably borrowed OwnedCell", pos);
    this.readers++;
    try { return f(this.value as T); } finally { this.readers--; }
  }
  withMut<R>(f: (v: T) => R, pos?: Pos): R {
    if (!this.full) trap("T008", "withMut on empty OwnedCell", pos);
    if (this.mutBorrowed || this.readers > 0) trap("T008", "withMut on borrowed OwnedCell", pos);
    this.mutBorrowed = true;
    try { return f(this.value as T); } finally { this.mutBorrowed = false; }
  }
  isEmpty(): boolean { return !this.full; }
}

/** The host object the C addon calls back into: traps (D103) and container creation (D102). The
 * main thread's loader and each isolate's bootstrap pass their own runtime's copy to `init`. */
export const NATIVE_HOST = {
  trap: (code: number, file: string, line: number, col: number): never => trap(`T${String(code).padStart(3, "0")}` as TrapCode, "trap in C", file ? { file, line, col } : undefined),
  create: (alloc: unknown, cap: number, elem: ElemKind): unknown => Vec.create(alloc, cap, elem),
  createPool: (alloc: unknown, cap: number, elem: ElemKind): unknown => Pool.create(alloc, cap, elem),
  createArena: (alloc: unknown, bytes: number): unknown => Arena.create(alloc, bytes),
  createRing: (alloc: unknown, cap: number, elem: ElemKind): unknown => Ring.create(alloc, cap, elem),
  adoptRing: (v: RingTx | RingRx, elem: ElemKind): void => v.adopt(elem),
  adoptPool: (v: Pool, elem: ElemKind): void => v.adopt(elem),
  adopt: (v: Vec | Slice, elem: ElemKind): void => v.adopt(elem),
  reserve: (v: Vec, cap: number, len: number): void => v.reserve(cap, len),
};

/** undefined -> null (Map.get, find, ?. ...). */
export const nn = <T>(x: T | undefined): T | null => (x === undefined ? null : x);
/** indexOf / findIndex: -1 -> null (Q031). */
export const idxOrNull = (i: number): number | null => (i < 0 ? null : i);
/** charCodeAt: out of range -> T002 (Q031). */
export function charCodeAt(s: string, i: number, pos?: Pos): number {
  if (!inBounds(i, s.length)) trap("T002", `index ${i} out of range (length ${s.length})`, pos);
  return s.charCodeAt(i);
}

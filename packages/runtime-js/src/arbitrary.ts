import { Vec, type ElemKind } from "./collections.ts";
import type { Int32Type, NumType, NumVal } from "./num.ts";

/** Descriptor for generating, materializing, shrinking, and formatting Szigyr values (SPEC §16.1, §16.2). */
export type GenDesc =
  | { readonly k: "num"; readonly t: NumType }
  | { readonly k: "bool" }
  | { readonly k: "str" }
  | { readonly k: "null" }
  | { readonly k: "lit"; readonly v: readonly string[] }
  | { readonly k: "rec"; readonly f: readonly { readonly n: string; readonly d: GenDesc }[] }
  | { readonly k: "opt"; readonly of: GenDesc }
  | { readonly k: "union"; readonly m: readonly GenDesc[] }
  | { readonly k: "arr"; readonly of: GenDesc }
  | { readonly k: "set"; readonly of: GenDesc }
  | { readonly k: "map"; readonly key: GenDesc; readonly val: GenDesc }
  | { readonly k: "vec"; readonly of: GenDesc; readonly elem: ElemKind }
  | { readonly k: "tup"; readonly e: readonly GenDesc[] };

/** Deterministic mulberry32 PRNG returning values in [0, 1). */
export function createRng(seed = 0x9e3779b9): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

const INT_BOUNDS: Record<Int32Type, readonly [number, number, readonly number[]]> = {
  i8: [-128, 127, [0, 1, -1, -128, 127, -127, 126]],
  i16: [-32768, 32767, [0, 1, -1, -32768, 32767, -32767, 32766]],
  i32: [-2147483648, 2147483647, [0, 1, -1, -2147483648, 2147483647, -2147483647, 2147483646]],
  u8: [0, 255, [0, 1, 2, 254, 255]],
  u16: [0, 65535, [0, 1, 2, 65534, 65535]],
  u32: [0, 4294967295, [0, 1, 2, 4294967294, 4294967295]],
  usize: [0, 4294967295, [0, 1, 2, 4294967294, 4294967295]],
};
const I64_MIN = -(1n << 63n), I64_MAX = (1n << 63n) - 1n, U64_MAX = (1n << 64n) - 1n;
const I64_BOUNDS: readonly bigint[] = [0n, 1n, -1n, I64_MIN, I64_MAX, I64_MIN + 1n, I64_MAX - 1n, 9007199254740992n, -9007199254740992n];
const U64_BOUNDS: readonly bigint[] = [0n, 1n, 2n, U64_MAX - 1n, U64_MAX, 9007199254740992n, 1n << 63n];
const F64_BOUNDS = [0, -0, 1, -1, 0.5, -0.5, Number.MAX_VALUE, -Number.MAX_VALUE, Number.MIN_VALUE, Number.EPSILON, Infinity, -Infinity, NaN];
const F32_BOUNDS = [0, -0, 1, -1, 0.5, -0.5, 3.4028234663852886e+38, -3.4028234663852886e+38, 1.401298464324817e-45, 1.1920928955078125e-7, Infinity, -Infinity, NaN];
const STR_BOUNDS = ["", "a", " ", "\n", "0", "あ", "😀"];
const ASCII = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-";

const pick = <T>(xs: readonly T[], rng: () => number): T => xs[Math.floor(rng() * xs.length)]!;
const randInt = (lo: number, hi: number, rng: () => number): number => {
  const v = Math.floor(rng() * (hi - lo + 1)) + lo;
  return v === 0 ? 0 : v;
};

function genNum(t: NumType, rng: () => number, size: number): NumVal {
  if (t === "f64" || t === "f32") {
    const r = rng();
    if (r < 0.35) return pick(t === "f32" ? F32_BOUNDS : F64_BOUNDS, rng);
    const v = r < 0.7 ? (rng() * 2 - 1) * Math.max(1, size * 4) : (rng() * 2 - 1) * Math.pow(2, (rng() * 2 - 1) * (t === "f32" ? 30 : 50));
    return t === "f32" ? Math.fround(v) : v;
  }
  if (t === "i64" || t === "u64") {
    const r = rng();
    if (r < 0.3) return pick(t === "i64" ? I64_BOUNDS : U64_BOUNDS, rng);
    if (r < 0.75) {
      const span = Math.max(1, size * 4);
      return BigInt(randInt(t === "u64" ? 0 : -span, span, rng));
    }
    const hi = BigInt(Math.floor(rng() * 0x100000000));
    const lo = BigInt(Math.floor(rng() * 0x100000000));
    const u = (hi << 32n) | lo;
    return t === "i64" ? BigInt.asIntN(64, u) : u;
  }
  const [min, max, bounds] = INT_BOUNDS[t];
  const r = rng();
  if (r < 0.3) return pick(bounds, rng);
  if (r < 0.75) {
    const span = Math.max(1, size * 4);
    return randInt(Math.max(min, -span), Math.min(max, span), rng);
  }
  return randInt(min, max, rng);
}

function genStr(rng: () => number, size: number): string {
  if (rng() < 0.2) return pick(STR_BOUNDS, rng);
  const len = Math.floor(rng() * (Math.min(size, 20) + 1));
  let s = "";
  for (let i = 0; i < len; i++) s += rng() < 0.08 ? pick(["あ", "😀", "\n"], rng) : ASCII[Math.floor(rng() * ASCII.length)]!;
  return s;
}

function genOne(d: GenDesc, rng: () => number, size: number): unknown {
  const inner = Math.max(1, Math.floor(size / 2));
  const len = (cap: number): number => (rng() < 0.15 ? 0 : Math.floor(rng() * (Math.min(size, cap) + 1)));
  switch (d.k) {
    case "num": return genNum(d.t, rng, size);
    case "bool": return rng() < 0.5;
    case "str": return genStr(rng, size);
    case "null": return null;
    case "lit": return pick(d.v, rng);
    case "rec": return Object.fromEntries(d.f.map((f) => [f.n, genOne(f.d, rng, inner)]));
    case "opt": return rng() < 0.2 ? null : genOne(d.of, rng, size);
    case "union": { const idx = Math.floor(rng() * d.m.length); return { idx, val: genOne(d.m[idx]!, rng, size) }; }
    case "arr": case "vec": case "set": return Array.from({ length: len(15) }, () => genOne(d.of, rng, inner));
    case "map": return Array.from({ length: len(12) }, () => [genOne(d.key, rng, inner), genOne(d.val, rng, inner)]);
    case "tup": return d.e.map((x) => genOne(x, rng, inner));
  }
}

/** Generates raw argument values (prioritizing numeric boundaries) from descriptors. */
export function generateRaw(descs: readonly GenDesc[], rng: () => number, size: number): unknown[] {
  return descs.map((d) => genOne(d, rng, size));
}

function materializeOne(d: GenDesc, raw: unknown): unknown {
  switch (d.k) {
    case "num": case "bool": case "str": case "null": case "lit": return raw;
    case "rec": {
      const o = raw as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const f of d.f) out[f.n] = materializeOne(f.d, o[f.n]);
      return out;
    }
    case "opt": return raw === null ? null : materializeOne(d.of, raw);
    case "union": { const u = raw as { idx: number; val: unknown }; return materializeOne(d.m[u.idx]!, u.val); }
    case "arr": return (raw as unknown[]).map((x) => materializeOne(d.of, x));
    case "set": return new Set((raw as unknown[]).map((x) => materializeOne(d.of, x)));
    case "map": return new Map((raw as [unknown, unknown][]).map(([k, v]) => [materializeOne(d.key, k), materializeOne(d.val, v)]));
    case "vec": {
      const xs = raw as unknown[];
      const v = Vec.create(undefined, xs.length, d.elem);
      for (const x of xs) v.push(materializeOne(d.of, x));
      return v;
    }
    case "tup": { const xs = raw as unknown[]; return d.e.map((x, i) => materializeOne(x, xs[i])); }
  }
}

/** Materializes fresh, non-aliasing runtime values (including Vec, Array, Map, Set, Structs) per call. */
export function materializeArgs(descs: readonly GenDesc[], raw: readonly unknown[]): unknown[] {
  return descs.map((d, i) => materializeOne(d, raw[i]));
}

function shrinkBigInt(t: "i64" | "u64", v: bigint): bigint[] {
  if (v === 0n) return [];
  const min = t === "i64" ? I64_MIN : 0n, max = t === "i64" ? I64_MAX : U64_MAX;
  const raw: bigint[] = [0n];
  if (v < 0n) raw.push(-v);
  for (let step = v / 2n; step !== 0n; step = step / 2n) raw.push(v - step);
  raw.push(v / 2n, v > 0n ? v - 1n : v + 1n);
  const out: bigint[] = [];
  for (const c of raw) {
    if (c >= min && c <= max && c !== v && !out.includes(c)) out.push(c);
  }
  return out;
}

function shrinkNum(t: NumType, v: NumVal): NumVal[] {
  if (t === "i64" || t === "u64") return shrinkBigInt(t, v as bigint);
  const vn = v as number;
  const norm = (x: number): number =>
    t === "f32" ? (x === 0 ? 0 : Math.fround(x)) : t === "f64" ? (x === 0 ? 0 : x) : x === 0 ? 0 : Math.trunc(x);
  const fits = (x: number): boolean => {
    if (t === "f64" || t === "f32") return true;
    const [min, max] = INT_BOUNDS[t];
    return Number.isInteger(x) && x >= min && x <= max;
  };
  const raw: number[] = [];
  if (Number.isNaN(vn) || !Number.isFinite(vn)) raw.push(0, 1, -1);
  else if (Object.is(vn, -0)) raw.push(0);
  else if (vn !== 0) {
    raw.push(0);
    if (vn < 0) raw.push(-vn);
    if (t === "f64" || t === "f32") {
      if (!Number.isInteger(vn)) raw.push(Math.trunc(vn));
      raw.push(vn > 0 ? 1 : -1, vn / 2);
      if (Math.abs(vn) > 1) raw.push(vn > 0 ? vn - 1 : vn + 1);
    } else {
      for (let step = Math.trunc(vn / 2); step !== 0; step = Math.trunc(step / 2)) raw.push(vn - step);
      raw.push(Math.trunc(vn / 2), vn > 0 ? vn - 1 : vn + 1);
    }
  }
  const out: number[] = [];
  for (const c of raw) {
    const n = norm(c);
    if (fits(n) && !Object.is(n, vn) && !out.some((x) => Object.is(x, n))) out.push(n);
  }
  return out;
}

function shrinkStr(s: string): string[] {
  if (!s.length) return [];
  const out: string[] = [""];
  if (s.length > 1) {
    const h = Math.floor(s.length / 2);
    out.push(s.slice(0, h), s.slice(h));
  }
  const step = Math.max(1, Math.floor(s.length / 8));
  for (let i = 0; i < s.length && out.length < 14; i += step) out.push(s.slice(0, i) + s.slice(i + 1));
  if (s !== "a".repeat(s.length) && out.length < 16) out.push("a".repeat(s.length));
  return [...new Set(out)].filter((x) => x !== s);
}

function shrinkList<T>(xs: readonly T[], elemShrink: (x: T) => T[]): T[][] {
  const out: T[][] = [];
  if (xs.length > 0) out.push([]);
  if (xs.length > 1) {
    const h = Math.floor(xs.length / 2);
    out.push(xs.slice(0, h), xs.slice(h));
    const step = Math.max(1, Math.floor(xs.length / 8));
    for (let i = 0; i < xs.length; i += step) out.push([...xs.slice(0, i), ...xs.slice(i + 1)]);
  }
  for (let i = 0; i < xs.length; i++) {
    for (const c of elemShrink(xs[i]!)) {
      const next = xs.slice();
      next[i] = c;
      out.push(next);
    }
  }
  return out;
}

function shrinkOne(d: GenDesc, v: unknown): unknown[] {
  switch (d.k) {
    case "num": return shrinkNum(d.t, v as NumVal);
    case "bool": return v ? [false] : [];
    case "str": return shrinkStr(v as string);
    case "null": return [];
    case "lit": { const i = d.v.indexOf(v as string); return i > 0 ? [d.v[0]!] : []; }
    case "opt": return v === null ? [] : [null, ...shrinkOne(d.of, v)];
    case "union": {
      const u = v as { idx: number; val: unknown };
      const out: { idx: number; val: unknown }[] = [];
      if (u.idx > 0) out.push({ idx: 0, val: genOne(d.m[0]!, createRng(0), 0) });
      for (const c of shrinkOne(d.m[u.idx]!, u.val)) out.push({ idx: u.idx, val: c });
      return out;
    }
    case "rec": {
      const o = v as Record<string, unknown>, out: Record<string, unknown>[] = [];
      for (const f of d.f) for (const c of shrinkOne(f.d, o[f.n])) out.push({ ...o, [f.n]: c });
      return out;
    }
    case "arr": case "vec": case "set": return shrinkList(v as unknown[], (x) => shrinkOne(d.of, x));
    case "map":
      return shrinkList(v as [unknown, unknown][], ([k, val]) => [
        ...shrinkOne(d.key, k).map((nk): [unknown, unknown] => [nk, val]),
        ...shrinkOne(d.val, val).map((nv): [unknown, unknown] => [k, nv]),
      ]);
    case "tup": {
      const xs = v as unknown[], out: unknown[][] = [];
      for (let i = 0; i < d.e.length; i++) {
        for (const c of shrinkOne(d.e[i]!, xs[i])) {
          const next = xs.slice();
          next[i] = c;
          out.push(next);
        }
      }
      return out;
    }
  }
}

/** Deterministically shrinks a failing raw input towards 0 / empty within a step budget. */
export function shrinkRaw(descs: readonly GenDesc[], raw: readonly unknown[], fails: (cand: readonly unknown[]) => boolean, maxSteps = 200): unknown[] {
  let cur = [...raw];
  let steps = 0;
  let improved = true;
  while (improved && steps < maxSteps) {
    improved = false;
    for (let i = 0; i < descs.length && steps < maxSteps; i++) {
      for (const c of shrinkOne(descs[i]!, cur[i])) {
        if (steps >= maxSteps) break;
        steps++;
        const cand = cur.slice();
        cand[i] = c;
        if (fails(cand)) { cur = cand; improved = true; break; }
      }
    }
  }
  return cur;
}

/** Async counterpart of `shrinkRaw` for shrinking failing inputs of async functions. */
export async function shrinkRawAsync(descs: readonly GenDesc[], raw: readonly unknown[], fails: (cand: readonly unknown[]) => Promise<boolean>, maxSteps = 200): Promise<unknown[]> {
  let cur = [...raw];
  let steps = 0;
  let improved = true;
  while (improved && steps < maxSteps) {
    improved = false;
    for (let i = 0; i < descs.length && steps < maxSteps; i++) {
      for (const c of shrinkOne(descs[i]!, cur[i])) {
        if (steps >= maxSteps) break;
        steps++;
        const cand = cur.slice();
        cand[i] = c;
        if (await fails(cand)) { cur = cand; improved = true; break; }
      }
    }
  }
  return cur;
}

function formatOne(d: GenDesc, raw: unknown): unknown {
  switch (d.k) {
    case "num": {
      if (typeof raw === "bigint") return raw.toString();
      const x = raw as number;
      if (Number.isNaN(x)) return "NaN";
      if (x === Infinity) return "Infinity";
      if (x === -Infinity) return "-Infinity";
      return Object.is(x, -0) ? "-0" : x;
    }
    case "bool": case "str": case "null": case "lit": return raw;
    case "rec": {
      const o = raw as Record<string, unknown>, out: Record<string, unknown> = {};
      for (const f of d.f) out[f.n] = formatOne(f.d, o[f.n]);
      return out;
    }
    case "opt": return raw === null ? null : formatOne(d.of, raw);
    case "union": { const u = raw as { idx: number; val: unknown }; return formatOne(d.m[u.idx]!, u.val); }
    case "arr": case "vec": case "set": return (raw as unknown[]).map((x) => formatOne(d.of, x));
    case "map": return (raw as [unknown, unknown][]).map(([k, v]) => [formatOne(d.key, k), formatOne(d.val, v)]);
    case "tup": { const xs = raw as unknown[]; return d.e.map((x, i) => formatOne(x, xs[i])); }
  }
}

/** Formats raw generated arguments into a JSON-friendly representation for messages and witnesses. */
export function formatArgs(descs: readonly GenDesc[], raw: readonly unknown[]): unknown[] {
  return descs.map((d, i) => formatOne(d, raw[i]));
}

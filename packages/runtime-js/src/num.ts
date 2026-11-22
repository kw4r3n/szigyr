import { trap, type Pos } from "./trap.ts";

export type Int32Type = "i8" | "i16" | "i32" | "u8" | "u16" | "u32" | "usize";
export type Int64Type = "i64" | "u64";
export type IntType = Int32Type | Int64Type;
export type NumType = IntType | "f32" | "f64";
export type NumVal = number | bigint;

export const RANGE: Record<Int32Type, readonly [number, number]> = {
  i8: [-128, 127], i16: [-32768, 32767], i32: [-2147483648, 2147483647],
  u8: [0, 255], u16: [0, 65535], u32: [0, 4294967295], usize: [0, 4294967295],
};
export const RANGE64: Record<Int64Type, readonly [bigint, bigint]> = {
  i64: [-(1n << 63n), (1n << 63n) - 1n],
  u64: [0n, (1n << 64n) - 1n],
};

const is64 = (t: string): t is Int64Type => t === "i64" || t === "u64";

// `+ 0` turns -0 into +0: integers have no negative zero (Q090).
function inRange(t: Int32Type, r: number, pos?: Pos): number {
  const b = RANGE[t];
  return r >= b[0] && r <= b[1] ? r + 0 : trap("T001", `${t} overflow`, pos);
}
export function chk(lo: number, hi: number, r: number, t: Int32Type, pos?: Pos): number {
  return r >= lo && r <= hi ? r + 0 : trap("T001", `${t} overflow`, pos);
}
export function narrow(lo: number, hi: number, x: number, t: Int32Type, pos?: Pos): number {
  return x >= lo && x <= hi ? x : trap("T003", `cannot convert ${x} to ${t}`, pos);
}
function inRange64(t: Int64Type, r: bigint, pos?: Pos): bigint {
  const b = RANGE64[t];
  return r >= b[0] && r <= b[1] ? r : trap("T001", `${t} overflow`, pos);
}

// Operands are in range, so |a op b| < 2^64 and the double result is exact whenever it is in range (32-bit); 64-bit uses exact BigInt.
export function add(t: Int32Type, a: number, b: number, pos?: Pos): number;
export function add(t: Int64Type, a: bigint, b: bigint, pos?: Pos): bigint;
export function add(t: IntType, a: NumVal, b: NumVal, pos?: Pos): NumVal;
export function add(t: IntType, a: NumVal, b: NumVal, pos?: Pos): NumVal {
  return is64(t) ? inRange64(t, (a as bigint) + (b as bigint), pos) : inRange(t, (a as number) + (b as number), pos);
}
export function sub(t: Int32Type, a: number, b: number, pos?: Pos): number;
export function sub(t: Int64Type, a: bigint, b: bigint, pos?: Pos): bigint;
export function sub(t: IntType, a: NumVal, b: NumVal, pos?: Pos): NumVal;
export function sub(t: IntType, a: NumVal, b: NumVal, pos?: Pos): NumVal {
  return is64(t) ? inRange64(t, (a as bigint) - (b as bigint), pos) : inRange(t, (a as number) - (b as number), pos);
}
export function mul(t: Int32Type, a: number, b: number, pos?: Pos): number;
export function mul(t: Int64Type, a: bigint, b: bigint, pos?: Pos): bigint;
export function mul(t: IntType, a: NumVal, b: NumVal, pos?: Pos): NumVal;
export function mul(t: IntType, a: NumVal, b: NumVal, pos?: Pos): NumVal {
  return is64(t) ? inRange64(t, (a as bigint) * (b as bigint), pos) : inRange(t, (a as number) * (b as number), pos);
}
export function neg(t: Int32Type, a: number, pos?: Pos): number;
export function neg(t: Int64Type, a: bigint, pos?: Pos): bigint;
export function neg(t: IntType, a: NumVal, pos?: Pos): NumVal;
export function neg(t: IntType, a: NumVal, pos?: Pos): NumVal {
  return is64(t) ? inRange64(t, -(a as bigint), pos) : inRange(t, -(a as number), pos);
}

/** Wrap an exact integer (|x| < 2^53) into the range of `t`. */
function wrap(t: Int32Type, x: number): number {
  const b = RANGE[t], lo = b[0], m = b[1] - lo + 1;
  return ((((x - lo) % m) + m) % m) + lo;
}
const wrap64 = (t: Int64Type, x: bigint): bigint => (t === "i64" ? BigInt.asIntN(64, x) : BigInt.asUintN(64, x));

export function wrapAdd(t: Int32Type, a: number, b: number): number;
export function wrapAdd(t: Int64Type, a: bigint, b: bigint): bigint;
export function wrapAdd(t: IntType, a: NumVal, b: NumVal): NumVal;
export function wrapAdd(t: IntType, a: NumVal, b: NumVal): NumVal {
  return is64(t) ? wrap64(t, (a as bigint) + (b as bigint)) : wrap(t, (a as number) + (b as number));
}
export function wrapSub(t: Int32Type, a: number, b: number): number;
export function wrapSub(t: Int64Type, a: bigint, b: bigint): bigint;
export function wrapSub(t: IntType, a: NumVal, b: NumVal): NumVal;
export function wrapSub(t: IntType, a: NumVal, b: NumVal): NumVal {
  return is64(t) ? wrap64(t, (a as bigint) - (b as bigint)) : wrap(t, (a as number) - (b as number));
}
// 32-bit products exceed 2^53: Math.imul is exact modulo 2^32.
export function wrapMul(t: Int32Type, a: number, b: number): number;
export function wrapMul(t: Int64Type, a: bigint, b: bigint): bigint;
export function wrapMul(t: IntType, a: NumVal, b: NumVal): NumVal;
export function wrapMul(t: IntType, a: NumVal, b: NumVal): NumVal {
  if (is64(t)) return wrap64(t, (a as bigint) * (b as bigint));
  const an = a as number, bn = b as number;
  return RANGE[t][1] - RANGE[t][0] >= 2 ** 32 - 1 ? wrap(t, Math.imul(an, bn)) : wrap(t, an * bn);
}

export function divTrunc(t: Int32Type, a: number, b: number, pos?: Pos): number;
export function divTrunc(t: Int64Type, a: bigint, b: bigint, pos?: Pos): bigint;
export function divTrunc(t: IntType, a: NumVal, b: NumVal, pos?: Pos): NumVal;
export function divTrunc(t: IntType, a: NumVal, b: NumVal, pos?: Pos): NumVal {
  if (is64(t)) {
    const ab = a as bigint, bb = b as bigint;
    if (bb === 0n) trap("T007", "division by zero", pos);
    return inRange64(t, ab / bb, pos);
  }
  const an = a as number, bn = b as number;
  if (bn === 0) trap("T007", "division by zero", pos);
  return inRange(t, (an - (an % bn)) / bn, pos); // exact; i8 -128 / -1 = 128 -> T001
}
/** Mathematically in range for every input, so no T001 (Q090). */
export function rem(t: Int32Type, a: number, b: number, pos?: Pos): number;
export function rem(t: Int64Type, a: bigint, b: bigint, pos?: Pos): bigint;
export function rem(t: IntType, a: NumVal, b: NumVal, pos?: Pos): NumVal;
export function rem(t: IntType, a: NumVal, b: NumVal, pos?: Pos): NumVal {
  if (is64(t)) {
    const ab = a as bigint, bb = b as bigint;
    if (bb === 0n) trap("T007", "remainder by zero", pos);
    return ab % bb;
  }
  const an = a as number, bn = b as number;
  if (bn === 0) trap("T007", "remainder by zero", pos);
  return (an % bn) + 0;
}

/** Single-rounds bigints > 2^53 to IEEE-754 binary32 by collapsing bits 0..11 into bit 12 (sticky region). */
function bigintToF32(x: bigint): number {
  const a = x < 0n ? -x : x;
  if (a <= 9007199254740992n) return Math.fround(Number(x));
  const adj = (a & 0xfffn) !== 0n ? (a & ~0xfffn) | 0x1000n : a;
  return Math.fround(x < 0n ? -Number(adj) : Number(adj));
}

/** Integer types: non-integer or out of range -> T003. f32: Math.fround (single-rounded). f64: Number/identity. */
export function convert(t: Int32Type | "f32" | "f64", x: NumVal, pos?: Pos): number;
export function convert(t: Int64Type, x: NumVal, pos?: Pos): bigint;
export function convert(t: NumType, x: NumVal, pos?: Pos): NumVal;
export function convert(t: NumType, x: NumVal, pos?: Pos): NumVal {
  if (typeof x === "bigint") {
    if (t === "f64") return Number(x);
    if (t === "f32") return bigintToF32(x);
    if (is64(t)) {
      const b = RANGE64[t];
      return x >= b[0] && x <= b[1] ? x : trap("T003", `cannot convert ${x} to ${t}`, pos);
    }
    const b = RANGE[t];
    return x >= BigInt(b[0]) && x <= BigInt(b[1]) ? Number(x) : trap("T003", `cannot convert ${x} to ${t}`, pos);
  }
  if (t === "f64") return x;
  if (t === "f32") return Math.fround(x);
  if (t === "i64") {
    return Number.isInteger(x) && x >= -9223372036854775808 && x < 9223372036854775808
      ? BigInt(x)
      : trap("T003", `cannot convert ${x} to i64`, pos);
  }
  if (t === "u64") {
    return Number.isInteger(x) && x >= 0 && x < 18446744073709551616
      ? BigInt(x)
      : trap("T003", `cannot convert ${x} to u64`, pos);
  }
  const b = RANGE[t];
  return Number.isInteger(x) && x >= b[0] && x <= b[1] ? x + 0 : trap("T003", `cannot convert ${x} to ${t}`, pos);
}
/** f32 results are rounded per operation (double arithmetic then fround is exact for + - * / sqrt). */
export const f32 = Math.fround;

// Bit operations (i32/u32: 0..31; i64/u64: 0..63, T009).
function amount(n: number, pos?: Pos): number {
  return Number.isInteger(n) && n >= 0 && n <= 31 ? n : trap("T009", `shift amount ${n} out of range`, pos);
}
function amount64(n: bigint, pos?: Pos): bigint {
  return n >= 0n && n <= 63n ? n : trap("T009", `shift amount ${n} out of range`, pos);
}
/** u32 results of & | ^ ~ come back signed from JS: normalize. u64 normalizes ~ from negative BigInt. */
export const toU32 = (x: number): number => x >>> 0;
export const toU64 = (x: bigint): bigint => BigInt.asUintN(64, x);

export function shl(t: "i32" | "u32", a: number, n: number, pos?: Pos): number;
export function shl(t: "i64" | "u64", a: bigint, n: bigint, pos?: Pos): bigint;
export function shl(t: "i32" | "u32" | "i64" | "u64", a: NumVal, n: NumVal, pos?: Pos): NumVal;
export function shl(t: "i32" | "u32" | "i64" | "u64", a: NumVal, n: NumVal, pos?: Pos): NumVal {
  if (t === "i64") return BigInt.asIntN(64, (a as bigint) << amount64(n as bigint, pos));
  if (t === "u64") return BigInt.asUintN(64, (a as bigint) << amount64(n as bigint, pos));
  const an = a as number, nn = n as number;
  return t === "u32" ? (an << amount(nn, pos)) >>> 0 : an << amount(nn, pos);
}
export function shr(a: number, n: number, pos?: Pos): number;
export function shr(a: bigint, n: bigint, pos?: Pos): bigint;
export function shr(a: NumVal, n: NumVal, pos?: Pos): NumVal;
export function shr(a: NumVal, n: NumVal, pos?: Pos): NumVal {
  return typeof a === "bigint" ? a >> amount64(n as bigint, pos) : a >> amount(n as number, pos);
}
export function ushr(a: number, n: number, pos?: Pos): number;
export function ushr(a: bigint, n: bigint, pos?: Pos): bigint;
export function ushr(a: NumVal, n: NumVal, pos?: Pos): NumVal;
export function ushr(a: NumVal, n: NumVal, pos?: Pos): NumVal {
  return typeof a === "bigint" ? a >> amount64(n as bigint, pos) : a >>> amount(n as number, pos);
}

import { trap, type Pos } from "./trap.ts";

export type IntType = "i8" | "i16" | "i32" | "u8" | "u16" | "u32" | "usize";
export type NumType = IntType | "f32" | "f64";

export const RANGE: Record<IntType, readonly [number, number]> = {
  i8: [-128, 127], i16: [-32768, 32767], i32: [-2147483648, 2147483647],
  u8: [0, 255], u16: [0, 65535], u32: [0, 4294967295], usize: [0, 4294967295],
};

// `+ 0` turns -0 into +0: integers have no negative zero (Q090).
function inRange(t: IntType, r: number, pos?: Pos): number {
  const [lo, hi] = RANGE[t];
  return r >= lo && r <= hi ? r + 0 : trap("T001", `${t} overflow`, pos);
}

// Operands are in range, so |a op b| < 2^64 and the double result is exact whenever it is in range.
export const add = (t: IntType, a: number, b: number, pos?: Pos): number => inRange(t, a + b, pos);
export const sub = (t: IntType, a: number, b: number, pos?: Pos): number => inRange(t, a - b, pos);
export const mul = (t: IntType, a: number, b: number, pos?: Pos): number => inRange(t, a * b, pos);
export const neg = (t: IntType, a: number, pos?: Pos): number => inRange(t, -a, pos);

/** Wrap an exact integer (|x| < 2^53) into the range of `t`. */
function wrap(t: IntType, x: number): number {
  const [lo, hi] = RANGE[t];
  const m = hi - lo + 1;
  return ((((x - lo) % m) + m) % m) + lo;
}
export const wrapAdd = (t: IntType, a: number, b: number): number => wrap(t, a + b);
export const wrapSub = (t: IntType, a: number, b: number): number => wrap(t, a - b);
// 32-bit products exceed 2^53: Math.imul is exact modulo 2^32.
export const wrapMul = (t: IntType, a: number, b: number): number =>
  RANGE[t][1] - RANGE[t][0] >= 2 ** 32 - 1 ? wrap(t, Math.imul(a, b)) : wrap(t, a * b);

export function divTrunc(t: IntType, a: number, b: number, pos?: Pos): number {
  if (b === 0) trap("T007", "division by zero", pos);
  return inRange(t, (a - (a % b)) / b, pos); // exact; i8 -128 / -1 = 128 -> T001
}
/** Mathematically in range for every input, so no T001 (Q090). */
export function rem(t: IntType, a: number, b: number, pos?: Pos): number {
  if (b === 0) trap("T007", "remainder by zero", pos);
  return (a % b) + 0;
}

/** Integer types: non-integer or out of range -> T003. f32: Math.fround. f64: identity. */
export function convert(t: NumType, x: number, pos?: Pos): number {
  if (t === "f64") return x;
  if (t === "f32") return Math.fround(x);
  const [lo, hi] = RANGE[t];
  return Number.isInteger(x) && x >= lo && x <= hi ? x + 0 : trap("T003", `cannot convert ${x} to ${t}`, pos);
}
/** f32 results are rounded per operation (double arithmetic then fround is exact for + - * / sqrt). */
export const f32 = Math.fround;

// Bit operations (i32 / u32 only). Amounts must be 0..31 (T009).
function amount(n: number, pos?: Pos): number {
  return Number.isInteger(n) && n >= 0 && n <= 31 ? n : trap("T009", `shift amount ${n} out of range`, pos);
}
/** u32 results of & | ^ ~ come back signed from JS: normalize. */
export const toU32 = (x: number): number => x >>> 0;
export const shl = (t: "i32" | "u32", a: number, n: number, pos?: Pos): number => (t === "u32" ? (a << amount(n, pos)) >>> 0 : a << amount(n, pos));
export const shr = (a: number, n: number, pos?: Pos): number => a >> amount(n, pos);
export const ushr = (a: number, n: number, pos?: Pos): number => a >>> amount(n, pos);

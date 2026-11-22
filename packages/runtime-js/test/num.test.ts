import { describe, expect, it } from "vitest";
import { Trap, add, sub, mul, neg, chk, narrow, wrapAdd, wrapSub, wrapMul, divTrunc, rem, convert, f32, shl, shr, ushr, toU32, type Pos } from "../src/index.ts";

const pos: Pos = { file: "a.ts", line: 3, col: 7 };
const trapOf = (f: () => unknown): Trap => { try { f(); } catch (e) { if (e instanceof Trap) return e; throw e; } throw new Error("no trap"); };

describe("checked arithmetic", () => {
  it("i32 boundaries", () => {
    expect(add("i32", 2147483646, 1)).toBe(2147483647);
    const t = trapOf(() => add("i32", 2147483647, 1, pos));
    expect([t.code, t.pos]).toEqual(["T001", pos]);
    expect(trapOf(() => sub("i32", -2147483648, 1)).code).toBe("T001");
    expect(trapOf(() => mul("i32", 65536, 32768)).code).toBe("T001");
    expect(mul("i32", 65536, -32768)).toBe(-2147483648);
  });
  it("unsigned underflow and u32 max", () => {
    expect(trapOf(() => sub("u8", 0, 1)).code).toBe("T001");
    expect(add("u32", 4294967294, 1)).toBe(4294967295);
    expect(trapOf(() => mul("u32", 4294967295, 4294967295)).code).toBe("T001");
    expect(trapOf(() => add("usize", 4294967295, 1)).code).toBe("T001");
  });
  it("unary minus", () => {
    expect(trapOf(() => neg("i8", -128)).code).toBe("T001");
    expect(neg("i8", 127)).toBe(-127);
    expect(Object.is(neg("i32", 0), 0)).toBe(true); // no -0 for integers
    expect(Object.is(mul("i32", -3, 0), 0)).toBe(true);
  });
});

describe("wrapping", () => {
  it("small types", () => {
    expect(wrapAdd("u8", 250, 10)).toBe(4);
    expect(wrapMul("u8", 16, 16)).toBe(0);
    expect(wrapMul("u8", 14, 14)).toBe(196);
    expect(wrapAdd("i8", 127, 1)).toBe(-128);
    expect(wrapSub("i8", -128, 1)).toBe(127);
    expect(wrapSub("u8", 0, 1)).toBe(255);
    expect(wrapAdd("i16", 32767, 1)).toBe(-32768);
  });
  it("32-bit multiplication is exact", () => {
    expect(wrapMul("u32", 4294967295, 4294967295)).toBe(1); // (-1)*(-1)
    expect(wrapMul("u32", 2166136261, 16777619)).toBe(Number((2166136261n * 16777619n) & 0xffffffffn));
    expect(wrapMul("i32", 2147483647, 2147483647)).toBe(1);
    expect(wrapMul("i32", -2147483648, -1)).toBe(-2147483648);
    expect(wrapMul("usize", 123456789, 987654321)).toBe(Number((123456789n * 987654321n) & 0xffffffffn));
  });
  it("32-bit add/sub", () => {
    expect(wrapAdd("u32", 4294967295, 1)).toBe(0);
    expect(wrapSub("i32", -2147483648, 1)).toBe(2147483647);
  });
});

describe("division", () => {
  it("truncates toward zero; rem has the dividend's sign", () => {
    expect([divTrunc("i32", -7, 2), rem("i32", -7, 2)]).toEqual([-3, -1]);
    expect([divTrunc("i32", 7, -2), rem("i32", 7, -2)]).toEqual([-3, 1]);
    expect(divTrunc("i32", -2147483648, 7)).toBe(-306783378);
    expect(Object.is(divTrunc("i32", -1, 2), 0)).toBe(true);
    expect(Object.is(rem("i32", -4, 2), 0)).toBe(true);
  });
  it("traps", () => {
    expect(trapOf(() => divTrunc("i32", 1, 0, pos)).code).toBe("T007");
    expect(trapOf(() => rem("u8", 1, 0)).code).toBe("T007");
    expect(trapOf(() => divTrunc("i8", -128, -1, pos)).code).toBe("T001");
    expect(divTrunc("i8", -128, 1)).toBe(-128);
    expect(rem("i8", -128, -1)).toBe(0);
  });
  it("large u32 quotient is exact", () => {
    expect(divTrunc("u32", 4294967295, 3)).toBe(1431655765);
    expect(divTrunc("u32", 4294967295, 4294967295)).toBe(1);
  });
});

describe("convert", () => {
  it("integer targets", () => {
    expect(convert("i32", 42)).toBe(42);
    expect(trapOf(() => convert("u8", 256, pos)).code).toBe("T003");
    expect(trapOf(() => convert("u8", -1)).code).toBe("T003");
    expect(trapOf(() => convert("i32", 1.5)).code).toBe("T003");
    expect(trapOf(() => convert("i32", NaN)).code).toBe("T003");
    expect(trapOf(() => convert("i32", Infinity)).code).toBe("T003");
    expect(convert("i8", -128)).toBe(-128);
    expect(Object.is(convert("u32", -0), 0)).toBe(true);
  });
  it("float targets", () => {
    expect(convert("f32", 16777217)).toBe(16777216);
    expect(convert("f32", 0.1)).toBe(0.10000000149011612);
    expect(convert("f64", 0.1)).toBe(0.1);
  });
  it("f32 rounding per operation", () => {
    const a = f32(0.1), b = f32(0.2);
    expect(f32(a + b)).toBe(0.30000001192092896);
    expect(f32(f32(a + b) + f32(0.3))).toBe(0.6000000238418579);
  });
  it("chk and narrow helpers", () => {
    expect(chk(-128, 127, 42, "i8")).toBe(42);
    expect(Object.is(chk(-128, 127, -0, "i8"), 0)).toBe(true);
    const t1 = trapOf(() => chk(-128, 127, 128, "i8", pos));
    expect([t1.code, t1.pos]).toEqual(["T001", pos]);
    expect(narrow(0, 255, 255, "u8")).toBe(255);
    const t3 = trapOf(() => narrow(0, 255, 256, "u8", pos));
    expect([t3.code, t3.pos]).toEqual(["T003", pos]);
  });
});

describe("bit ops", () => {
  it("shift amount 0..31 only", () => {
    expect(shl("u32", 1, 31)).toBe(2147483648);
    expect(shl("i32", 1, 31)).toBe(-2147483648);
    expect(trapOf(() => shl("u32", 1, 32, pos)).code).toBe("T009");
    expect(trapOf(() => shr(1, -1)).code).toBe("T009");
    expect(trapOf(() => ushr(1, 32)).code).toBe("T009");
    expect(shr(-15, 2)).toBe(-4);
    expect(ushr(0xf0f0f0f0, 4)).toBe(252645135);
    expect(shl("u32", 0xf0f0f0f0, 4)).toBe(252645120);
  });
  it("u32 normalization", () => {
    expect(toU32(0xf0f0f0f0 | 0x0f0f0f0f)).toBe(4294967295);
    expect(toU32(~0xf0f0f0f0)).toBe(252645135);
    expect(toU32(0xf0f0f0f0 & 0x80000000)).toBe(2147483648);
  });
});

describe("64-bit integers (i64 / u64)", () => {
  const I64_MIN = -(1n << 63n);
  const I64_MAX = (1n << 63n) - 1n;
  const U64_MAX = (1n << 64n) - 1n;

  it("checked arithmetic & boundaries", () => {
    expect(add("i64", I64_MAX - 1n, 1n)).toBe(I64_MAX);
    expect(trapOf(() => add("i64", I64_MAX, 1n, pos)).code).toBe("T001");
    expect(trapOf(() => sub("i64", I64_MIN, 1n)).code).toBe("T001");
    expect(trapOf(() => neg("i64", I64_MIN)).code).toBe("T001");
    expect(neg("i64", I64_MAX)).toBe(-I64_MAX);
    expect(mul("i64", 1n << 32n, 1n << 30n)).toBe(1n << 62n);
    expect(trapOf(() => mul("i64", 1n << 32n, 1n << 31n)).code).toBe("T001");
    expect(add("u64", U64_MAX - 1n, 1n)).toBe(U64_MAX);
    expect(trapOf(() => add("u64", U64_MAX, 1n)).code).toBe("T001");
    expect(trapOf(() => sub("u64", 0n, 1n)).code).toBe("T001");
    expect(mul("u64", 0xffffffffn, 0xffffffffn)).toBe(0xfffffffe00000001n);
    expect(trapOf(() => mul("u64", 1n << 63n, 2n)).code).toBe("T001");
  });

  it("wrapping & division", () => {
    expect(wrapAdd("i64", I64_MAX, 1n)).toBe(I64_MIN);
    expect(wrapSub("i64", I64_MIN, 1n)).toBe(I64_MAX);
    expect(wrapMul("i64", I64_MIN, -1n)).toBe(I64_MIN);
    expect(wrapAdd("u64", U64_MAX, 1n)).toBe(0n);
    expect(wrapSub("u64", 0n, 1n)).toBe(U64_MAX);
    expect(wrapMul("u64", U64_MAX, U64_MAX)).toBe(1n);
    expect([divTrunc("i64", -7n, 2n), rem("i64", -7n, 2n)]).toEqual([-3n, -1n]);
    expect(divTrunc("i64", I64_MIN, 1n)).toBe(I64_MIN);
    expect(rem("i64", I64_MIN, -1n)).toBe(0n);
    expect(trapOf(() => divTrunc("i64", I64_MIN, -1n, pos)).code).toBe("T001");
    expect(trapOf(() => divTrunc("u64", 1n, 0n, pos)).code).toBe("T007");
    expect(trapOf(() => rem("i64", 1n, 0n)).code).toBe("T007");
    expect(divTrunc("u64", U64_MAX, 3n)).toBe(6148914691236517205n);
  });

  it("bitwise & shifts (0..63)", () => {
    expect(shl("u64", 1n, 63n)).toBe(1n << 63n);
    expect(shl("i64", 1n, 63n)).toBe(I64_MIN);
    expect(shr(I64_MIN, 63n)).toBe(-1n);
    expect(ushr(U64_MAX, 63n)).toBe(1n);
    expect(trapOf(() => shl("u64", 1n, 64n, pos)).code).toBe("T009");
    expect(trapOf(() => shr(1n, -1n)).code).toBe("T009");
    expect(trapOf(() => ushr(1n, 64n)).code).toBe("T009");
  });

  it("conversions & single-rounded f32", () => {
    expect(convert("i64", 9007199254740992)).toBe(9007199254740992n);
    expect(convert("u64", 18446744073709551615 - 2048)).toBe(18446744073709551616n - 2048n);
    expect(trapOf(() => convert("i64", 9223372036854775808)).code).toBe("T003");
    expect(trapOf(() => convert("u64", 18446744073709551616)).code).toBe("T003");
    expect(trapOf(() => convert("u64", -1)).code).toBe("T003");
    expect(trapOf(() => convert("u64", -1n)).code).toBe("T003");
    expect(trapOf(() => convert("i64", U64_MAX)).code).toBe("T003");
    expect(trapOf(() => convert("i32", I64_MAX)).code).toBe("T003");
    expect(convert("i32", 42n)).toBe(42);
    // Avoids binary64 intermediate rounding: (2^63 + 2^39 + 1) rounds up to 2^63 + 2^40 in binary32.
    const stickyEdge = (1n << 63n) + (1n << 39n) + 1n;
    expect(convert("f32", stickyEdge)).toBe(Number((1n << 63n) + (1n << 40n)));
  });
});

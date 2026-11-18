import { describe, expect, it } from "vitest";
import { Trap, add, sub, mul, neg, wrapAdd, wrapSub, wrapMul, divTrunc, rem, convert, f32, shl, shr, ushr, toU32, type Pos } from "../src/index.ts";

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

// expect: ok
// stage: 1
// open-question: Q014
export function hasFlag(flags: u32, bit: u32): boolean {
  return (flags & (1 << bit)) !== 0;
}

export function rotl(x: u32, n: u32): u32 {
  requires(n > 0 && n < 32);
  return (x << n) | (x >>> (32 - n));
}

export function sar(x: i32, n: i32): i32 {
  return x >> n;
}

export function lowByte(x: u32): u32 {
  return x & 255;
}

export function flip(x: i32): i32 {
  return ~x;
}

export function xorMix(a: u32, b: u32): u32 {
  return a ^ b;
}

test("bitwise", (t: Test) => {
  t.ok(hasFlag(5, 2));
  t.ok(!hasFlag(5, 1));
  t.eq(rotl(1, 31), 2147483648);
  t.eq(sar(-8, 1), -4);
  t.eq(lowByte(0x1234), 0x34);
  t.eq(flip(0), -1);
  t.eq(xorMix(6, 3), 5);
  t.traps("T009", () => {
    sar(1, 32);
  });
});

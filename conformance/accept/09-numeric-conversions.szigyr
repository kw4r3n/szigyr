// expect: ok
// stage: 1
// open-question: Q014
// open-question: Q015
export function toByte(x: i32): u8 {
  return u8(x);
}

export function widen(x: u8): u32 {
  return u32(x);
}

export function avg(a: f32, b: f32): f32 {
  return (a + b) / 2;
}

export function toIndex(n: i32): usize {
  return usize(n);
}

export function mixed(a: i32, b: f64): f64 {
  return f64(a) + b;
}

export function maxByte(): u8 {
  const c: u8 = 255;
  return c;
}

export function minInt(): i32 {
  const m: i32 = -2147483648;
  return m;
}

export function hexLit(): u32 {
  return 0xff;
}

export function scale(x: f32): f32 {
  return x * 0.5;
}

export function floorToInt(x: f64): i32 {
  return i32(Math.floor(x));
}

export function countdown(n: usize): usize {
  let i: usize = n;
  let steps: usize = 0;
  while (i > 0) {
    i -= 1;
    steps += 1;
  }
  return steps;
}

test("numeric", (t: Test) => {
  t.eq(toByte(200), 200);
  t.eq(widen(7), 7);
  t.eq(avg(1, 2), 1.5);
  t.eq(mixed(2, 0.5), 2.5);
  t.eq(maxByte(), 255);
  t.eq(hexLit(), 255);
  t.eq(floorToInt(2.7), 2);
  t.eq(toIndex(5), 5);
  t.eq(scale(3), 1.5);
  t.eq(countdown(3), 3);
  t.traps("T003", () => {
    toByte(300);
  });
});

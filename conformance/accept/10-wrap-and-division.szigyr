// expect: ok
// stage: 1
export function hashStep(h: u32, x: u32): u32 {
  return wrapAdd(wrapMul(h, 31), x);
}

export function diff(a: u8, b: u8): u8 {
  return wrapSub(a, b);
}

export function quot(a: i32, b: i32): i32 {
  return divTrunc(a, b);
}

export function remainder(a: i32, b: i32): i32 {
  return rem(a, b);
}

export function mean(xs: ReadonlyArray<i32>): i32 {
  if (xs.length === 0) {
    return 0;
  }
  let total: i32 = 0;
  for (const x of xs) {
    total += x;
  }
  return divTrunc(total, i32(xs.length));
}

test("wrap and division", (t: Test) => {
  t.eq(diff(1, 2), 255);
  t.eq(hashStep(0, 5), 5);
  t.eq(quot(-7, 2), -3);
  t.eq(remainder(-7, 2), -1);
  t.eq(mean([1, 2, 6]), 3);
  t.traps("T007", () => {
    quot(1, 0);
  });
});

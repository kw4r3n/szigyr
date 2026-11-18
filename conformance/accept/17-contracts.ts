// expect: ok
// stage: 1
// open-question: Q056
// open-question: Q057
// open-question: Q029
export function sqrtFloor(n: u32): u32 {
  requires(n < 1000000);
  ensures((r: u32) => r * r <= n);
  let k: u32 = 0;
  while ((k + 1) * (k + 1) <= n) {
    invariant(k * k <= n);
    k += 1;
  }
  return k;
}

export function clamp(x: i32, lo: i32, hi: i32): i32 {
  requires(lo <= hi);
  ensures((r: i32) => r >= lo && r <= hi);
  if (x < lo) {
    return lo;
  }
  if (x > hi) {
    return hi;
  }
  return x;
}

export function sumTo(xs: ReadonlyArray<i32>): i32 {
  let s: i32 = 0;
  for (let i: usize = 0; i < xs.length; i += 1) {
    invariant(i < xs.length);
    s += xs[i];
  }
  return s;
}

class Gauge {
  private level: u32;

  constructor(level: u32) {
    this.level = level;
  }

  drain(n: u32): u32 {
    requires(n > 0);
    ensures((r: u32) => r <= 100);
    if (n > this.level) {
      this.level = 0;
    } else {
      this.level -= n;
    }
    return this.level;
  }
}

test("contracts", (t: Test) => {
  t.eq(sqrtFloor(17), 4);
  t.eq(clamp(9, 0, 5), 5);
  t.eq(sumTo([1, 2, 3]), 6);
  const g = new Gauge(10);
  t.eq(g.drain(3), 7);
  t.traps("T004", () => {
    clamp(0, 5, 1);
  });
  t.traps("T004", () => {
    sqrtFloor(2000000);
  });
});

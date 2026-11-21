// expect: ok
// stage: 1
// open-question: Q052
// open-question: Q053
type Pt = { readonly x: f64; readonly y: f64 };
type Pt3 = { readonly x: f64; readonly y: f64; readonly z: f64 };

export function norm1(p: Pt): f64 {
  const { x, y } = p;
  return Math.abs(x) + Math.abs(y);
}

export function product(p: Pt): f64 {
  const { x: a, y: b } = p;
  return a * b;
}

export function moveX(p: Pt, dx: f64): Pt {
  return { ...p, x: p.x + dx };
}

export function lift(p: Pt, z: f64): Pt3 {
  return { ...p, z };
}

export function join(a: Array<i32>, b: Array<i32>): Array<i32> {
  return [...a, ...b, 0];
}

test("destructure and spread", (t: Test) => {
  t.eq(norm1({ x: -1, y: 2 }), 3);
  t.eq(product({ x: 2, y: 3 }), 6);
  t.eq(moveX({ x: 1, y: 2 }, 5), { x: 6, y: 2 });
  t.eq(lift({ x: 1, y: 2 }, 3), { x: 1, y: 2, z: 3 });
  t.eq(join([1], [2, 3]), [1, 2, 3, 0]);
});

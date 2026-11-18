// expect: ok
// stage: 1
// open-question: Q054
type Point = { readonly x: f64; readonly y: f64 };
type Counter = { readonly name: string; hits: u32 };

const ORIGIN: Point = { x: 0, y: 0 };

export function origin(): Point {
  return ORIGIN;
}

export function dist2(a: Point, b: Point): f64 {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function bump(c: Counter): void {
  c.hits += 1;
}

test("records", (t: Test) => {
  t.eq(dist2({ x: 3, y: 4 }, origin()), 25);
  const c: Counter = { name: "a", hits: 0 };
  bump(c);
  bump(c);
  t.eq(c.hits, 2);
});

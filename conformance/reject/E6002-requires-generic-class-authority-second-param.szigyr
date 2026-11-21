// expect: E6002 @ 9:12
// stage: 1
class Box<T> {
  readonly v: T;
  constructor(v: T) { this.v = v; }
}
function leak(a: Box<i32>, b: Box<Clock>): f64 { return b.v.nowMs(); }
export function f(a: Box<i32>, b: Box<Clock>): f64 {
  requires(leak(a, b) > 0);
  return 1;
}

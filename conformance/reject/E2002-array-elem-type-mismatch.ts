// expect: E2002 @ 4:10
// stage: 1
function f(a: Array<i32>): ReadonlyArray<f64> {
  return a;
}

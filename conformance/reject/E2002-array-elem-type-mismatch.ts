// expect: E2002 @ 5:10
// stage: 1
// open-question: Q020
function f(a: Array<i32>): ReadonlyArray<f64> {
  return a;
}

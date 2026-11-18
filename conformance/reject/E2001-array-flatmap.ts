// expect: E2001 @ 5:12
// stage: 1
// open-question: Q007
function f(a: Array<f64>): Array<f64> {
  return a.flatMap((x: f64): Array<f64> => a);
}

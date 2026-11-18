// expect: E2006 @ 5:17
// stage: 1
// open-question: Q022
function f(a: Array<f64>): Array<f64> {
  return a.map((x) => x);
}

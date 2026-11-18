// expect: E2007 @ 4:19
// stage: 1
function f(a: Array<f64>): usize {
  return a.length / 2;
}

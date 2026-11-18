// expect: E3007 @ 4:36
// stage: 2
// open-question: Q174
function f(xs: ReadonlyArray<Array<Vec<f32>>>): usize {
  return xs.length;
}

// expect: E3007 @ 5:19
// stage: 2
// open-question: Q174
type Bx<T> = Array<T>;
function f(xs: Bx<Vec<f32>>): usize {
  return xs.length;
}

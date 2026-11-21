// expect: E3007 @ 8:19
// stage: 2
// open-question: Q174
class C<T> {
  xs: Array<T> = [];
}
function f(): usize {
  const c = new C<Vec<f32>>();
  return c.xs.length;
}

// expect: ok
// stage: 2
// open-question: Q174
type Bx<T> = { readonly xs: Array<T> };
class C<T> {
  xs: Array<T> = [];
}
function f(b: Bx<f32>, c: C<string>): usize {
  return b.xs.length + c.xs.length;
}

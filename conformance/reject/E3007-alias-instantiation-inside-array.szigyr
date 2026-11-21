// expect: E3007 @ 7:18
// stage: 2
// open-question: Q174
type Bx<T> = { readonly xs: Array<T> };
function f(): usize {
  const b: Bx<Set<string>> | null = null;
  const c: Array<Bx<Vec<f32>>> = [];
  return c.length;
}

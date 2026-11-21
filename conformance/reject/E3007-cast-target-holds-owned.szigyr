// expect: E3007 @ 6:18
// stage: 2
// open-question: Q174
type Bx<T> = { readonly xs: Array<T> };
function f(x: unknown): boolean {
  const r = cast<Bx<Vec<f32>>>(x);
  return r.kind === "ok";
}

// expect: E3007 @ 13:16
// stage: 2
// open-question: Q174
type Bx<T> = { readonly xs: Array<T> };
function mk(alloc: Alloc): Vec<f32> {
  "use owned";
  return Vec.create<f32>(alloc, 2);
}
function empty<T>(): Bx<T> {
  return { xs: [] };
}
function f(): usize {
  return empty<Vec<f32>>().xs.length;
}

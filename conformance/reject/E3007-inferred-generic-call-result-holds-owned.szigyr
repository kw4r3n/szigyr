// expect: E3007 @ 13:13
// stage: 2
// open-question: Q174
type Bx<T> = { readonly xs: Array<T> };
function mk(alloc: Alloc): Vec<f32> {
  "use owned";
  return Vec.create<f32>(alloc, 2);
}
function wrap<T>(x: T): Bx<T> {
  return { xs: [] };
}
function f(al: Alloc): usize {
  const b = wrap(mk(al));
  return b.xs.length;
}

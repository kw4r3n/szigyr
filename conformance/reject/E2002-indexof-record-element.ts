// expect: E2002 @ 7:13
// stage: 1
// open-question: Q032
// open-question: Q083
type P = { readonly x: i32 };
function find(xs: ReadonlyArray<P>, p: P): usize | null {
  return xs.indexOf(p);
}

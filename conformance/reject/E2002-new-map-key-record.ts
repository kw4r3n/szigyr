// expect: E2002 @ 6:21
// stage: 1
// open-question: Q081
type P = { readonly x: i32 };
function f(): usize {
  const m = new Map<P, i32>();
  return m.size;
}

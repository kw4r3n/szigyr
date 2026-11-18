// expect: E2002 @ 12:10
// stage: 1
// open-question: Q127
type P = { readonly x: f64 };
function cnt<T>(xs: Array<T>): usize {
  const s: Set<T> = new Set<T>();
  for (const x of xs) { s.add(x); }
  return s.size;
}
function f(): usize {
  const a: Array<P> = [{ x: 1 }];
  return cnt(a);
}

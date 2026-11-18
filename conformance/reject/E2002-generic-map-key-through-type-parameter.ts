// expect: E2002 @ 14:16
// stage: 1
// open-question: Q127
type P = { readonly x: f64 };
function keys<K>(k: K): usize {
  const m: Map<K, i32> = new Map<K, i32>();
  m.set(k, 1);
  return m.size;
}
function outer<U>(u: U): usize {
  return keys<U>(u);
}
function f(p: P): usize {
  return outer<P>(p);
}

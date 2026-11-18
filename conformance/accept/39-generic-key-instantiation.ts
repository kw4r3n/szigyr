// expect: ok
// stage: 1
function cnt<T>(xs: Array<T>): usize {
  const s: Set<T> = new Set<T>();
  for (const x of xs) { s.add(x); }
  return s.size;
}
function outer<U>(xs: Array<U>): usize {
  return cnt<U>(xs);
}
class Bag<T> {
  s: Set<T>;
  constructor() {
    this.s = new Set<T>();
  }
}
function f(): usize {
  const a: Array<string> = ["a", "b"];
  const b: Bag<i32> = new Bag<i32>();
  return outer(a) + cnt<string>(a) + b.s.size;
}

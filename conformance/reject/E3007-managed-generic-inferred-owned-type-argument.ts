// expect: E3007 @ 6:14
// stage: 2
// open-question: Q068
function wrap<T>(x: T): Array<T> { return [x]; }
function f(alloc: Alloc): usize {
  const xs = wrap(Vec.create<f32>(alloc, 1));
  return xs.length;
}

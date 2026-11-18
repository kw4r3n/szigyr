// expect: E3007 @ 6:28
// stage: 2
// open-question: Q068
function pick<T>(x: T, y: T): T { return x; }
function f(alloc: Alloc): usize {
  const w: Vec<f32> = pick<Vec<f32>>(Vec.create<f32>(alloc, 1), Vec.create<f32>(alloc, 2));
  return w.length;
}

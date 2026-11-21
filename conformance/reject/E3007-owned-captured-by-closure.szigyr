// expect: E3007 @ 6:26
// stage: 2
// open-question: Q012
function f(alloc: Alloc): usize {
  const a = Vec.create<f32>(alloc, 1);
  const g = (): usize => a.length;
  return g();
}

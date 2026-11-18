// expect: E3007 @ 6:32
// stage: 2
// open-question: Q048
function f(alloc: Alloc): void {
  const a = Vec.create<f32>(alloc, 1);
  const xs: Array<Vec<f32>> = [a];
}

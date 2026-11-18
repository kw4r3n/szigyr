// expect: E3007 @ 7:11
// stage: 2
// open-question: Q048
function f(alloc: Alloc): void {
  const xs: Array<Vec<f32>> = [];
  const a = Vec.create<f32>(alloc, 1);
  xs.push(a);
}

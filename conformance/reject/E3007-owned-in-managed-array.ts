// expect: E3007 @ 5:33
// stage: 2
// open-question: Q174
// open-question: Q048
function u(alloc: Alloc): Array<Vec<f32>> {
  const xs: Array<Vec<f32>> = [];
  xs.push(Vec.create<f32>(alloc, 1));
  return xs;
}

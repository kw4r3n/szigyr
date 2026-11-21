// expect: E3007 @ 8:41
// stage: 2
// open-question: Q174
function mk(alloc: Alloc): Vec<f32> {
  "use owned";
  return Vec.create<f32>(alloc, 2);
}
async function h(alloc: Alloc): Promise<Vec<f32>> {
  return mk(alloc);
}
async function f(alloc: Alloc): Promise<usize> {
  const v = await h(alloc);
  return v.length;
}

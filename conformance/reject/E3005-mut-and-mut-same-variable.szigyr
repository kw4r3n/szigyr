// expect: E3005 @ 10:11
// stage: 2
// open-question: Q002
function swap(a: Mut<Vec<f32>>, b: Mut<Vec<f32>>): void {
  "use owned";
}
function g(alloc: Alloc): void {
  "use owned";
  const v = Vec.create<f32>(alloc, 4);
  swap(v, v);
}

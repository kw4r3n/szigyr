// expect: E3005 @ 10:12
// stage: 2
// open-question: Q002
function takes(a: Mut<Vec<f32>>, b: Vec<f32>): void {
  "use owned";
}
function g(alloc: Alloc): void {
  "use owned";
  const v = Vec.create<f32>(alloc, 4);
  takes(v, v);
}

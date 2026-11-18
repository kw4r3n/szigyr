// expect: E3005 @ 11:11
// stage: 2
// open-question: Q002
// open-question: Q152
function both(a: Ref<Vec<f32>>, b: Vec<f32>): void {
  "use owned";
}
function g(alloc: Alloc): void {
  "use owned";
  const v = Vec.create<f32>(alloc, 4);
  both(v, v);
}

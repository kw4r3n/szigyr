// expect: E3004 @ 7:3
// stage: 2
// open-question: Q077
// open-question: Q151
function g(v: Mut<Vec<f32>>, alloc: Alloc): void {
  "use owned";
  v = Vec.create<f32>(alloc, 4);
}

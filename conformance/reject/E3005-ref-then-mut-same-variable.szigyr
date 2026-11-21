// expect: E3005 @ 9:15
// stage: 2
// open-question: Q002
function copyFrom(src: Ref<Slice<f32>>, dst: Mut<Slice<f32>>): void {
  "use rt";
}
function g(v: Mut<Slice<f32>>): void {
  "use rt";
  copyFrom(v, v);
}

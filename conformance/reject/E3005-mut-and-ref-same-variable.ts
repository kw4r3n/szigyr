// expect: E3005 @ 9:15
// stage: 2
// open-question: Q002
function copyInto(dst: Mut<Slice<f32>>, src: Ref<Slice<f32>>): void {
  "use rt";
}
function g(v: Mut<Slice<f32>>): void {
  "use rt";
  copyInto(v, v);
}

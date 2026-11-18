// expect: E3005 @ 9:27
// stage: 2
// open-question: Q002
function copyInto(dst: Mut<Slice<f32>>, src: Ref<Slice<f32>>): void {
  "use rt";
}
function g(v: Mut<Vec<f32>>): void {
  "use rt";
  copyInto(v.slice(0, 2), v.slice(2, 4));
}

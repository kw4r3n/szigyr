// expect: E3005 @ 11:13
// stage: 2
// open-question: Q170
function wn(v: Mut<Slice<f32>>): f32 {
  "use rt";
  v.fill(1);
  return 0;
}
function f(v: Mut<Slice<f32>>): void {
  "use rt";
  v.fill(wn(v));
}

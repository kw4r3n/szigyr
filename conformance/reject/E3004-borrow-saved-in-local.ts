// expect: E3004 @ 6:13
// stage: 2
// open-question: Q002
function h(v: Ref<Slice<f32>>): f32 {
  "use rt";
  const w = v;
  return w[0];
}

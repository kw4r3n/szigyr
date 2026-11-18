// expect: E3004 @ 6:13
// stage: 2
// open-question: Q002
function h(v: Mut<Vec<f32>>): usize {
  "use owned";
  const w = v;
  return w.length;
}

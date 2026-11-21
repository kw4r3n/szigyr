// expect: E2002 @ 10:14
// stage: 2
// open-question: Q002
function len(v: Ref<Vec<f32>>): usize {
  "use rt";
  return v.length;
}
function g(s: Ref<Slice<f32>>): usize {
  "use rt";
  return len(s);
}

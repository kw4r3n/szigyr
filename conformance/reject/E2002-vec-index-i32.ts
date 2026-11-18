// expect: E2002 @ 6:12
// stage: 2
// open-question: Q002
function get(v: Ref<Vec<f32>>, i: i32): f32 {
  "use rt";
  return v[i];
}

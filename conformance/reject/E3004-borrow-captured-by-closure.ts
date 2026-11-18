// expect: E3004 @ 5:24
// stage: 2
// open-question: Q012
function f(v: Ref<Vec<f32>>): f32 {
  const g = (): f32 => v[0];
  return g();
}

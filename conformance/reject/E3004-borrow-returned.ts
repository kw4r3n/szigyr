// expect: E3004 @ 6:10
// stage: 2
// open-question: Q002
function f(v: Mut<Vec<f32>>): Vec<f32> {
  "use owned";
  return v;
}

// expect: E2002 @ 10:14
// stage: 2
// open-question: Q020
function sum(s: Ref<Slice<f64>>): f64 {
  "use owned";
  return s[0];
}
function g(v: Ref<Vec<f32>>): f64 {
  "use owned";
  return sum(v);
}

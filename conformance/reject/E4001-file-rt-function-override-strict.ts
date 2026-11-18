// expect: E4001 @ 11:10
// stage: 1
// open-question: Q002
// open-question: Q039
"use rt";
function strictHelper(x: f64): f64 {
  "use owned";
  return x;
}
function z(x: f64): f64 {
  return strictHelper(x);
}

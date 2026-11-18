// expect: E4001 @ 10:10
// stage: 1
// open-question: Q002
function strictHelper(x: f64): f64 {
  "use owned";
  return x;
}
function z(x: f64): f64 {
  "use rt";
  return strictHelper(x);
}

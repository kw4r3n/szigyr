// expect: E4001 @ 9:10
// stage: 1
// open-question: Q002
function managedHelper(x: f64): f64 {
  return x;
}
function z(x: f64): f64 {
  "use owned";
  return managedHelper(x);
}

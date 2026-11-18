// expect: E4003 @ 7:13
// stage: 2
// open-question: Q045
function mg(x: f64): f64 { return x; }
function f(x: f64): f64 {
  "use owned";
  const g = mg;
  return g(x);
}

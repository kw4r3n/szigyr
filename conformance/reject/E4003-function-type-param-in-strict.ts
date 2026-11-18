// expect: E4003 @ 4:15
// stage: 2
// open-question: Q002
function f(g: (x: f64) => f64, x: f64): f64 {
  "use owned";
  return g(x);
}

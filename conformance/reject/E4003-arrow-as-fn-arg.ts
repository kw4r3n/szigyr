// expect: E4003 @ 10:16
// stage: 2
// open-question: Q189
function apply(f: (x: f64) => f64, v: f64): f64 {
  "use owned";
  return f(v);
}
function g(v: f64): f64 {
  "use owned";
  return apply((x: f64) => x, v);
}

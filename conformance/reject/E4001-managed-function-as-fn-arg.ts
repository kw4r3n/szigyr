// expect: E4001 @ 11:16
// stage: 2
// open-question: Q189
function mg(x: f64): f64 { return x; }
function apply(f: (x: f64) => f64, v: f64): f64 {
  "use owned";
  return f(v);
}
function g(v: f64): f64 {
  "use owned";
  return apply(mg, v);
}

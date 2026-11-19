// expect: E2002 @ 14:16
// stage: 2
// open-question: Q189
function incI(a: i32): i32 {
  "use owned";
  return a + 1;
}
function apply(f: (x: f64) => f64, v: f64): f64 {
  "use owned";
  return f(v);
}
function g(v: f64): f64 {
  "use owned";
  return apply(incI, v);
}

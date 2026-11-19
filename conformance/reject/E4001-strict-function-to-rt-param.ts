// expect: E4001 @ 14:18
// stage: 2
// open-question: Q189
function incS(x: f64): f64 {
  "use owned";
  return x + 1;
}
function applyRt(f: (x: f64) => f64, v: f64): f64 {
  "use rt";
  return f(v);
}
function g(v: f64): f64 {
  "use owned";
  return applyRt(incS, v);
}

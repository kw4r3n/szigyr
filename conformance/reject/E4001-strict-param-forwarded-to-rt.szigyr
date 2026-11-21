// expect: E4001 @ 10:18
// stage: 2
// open-question: Q212
function applyRt(f: (x: f64) => f64, v: f64): f64 {
  "use rt";
  return f(v);
}
function outer(f: (x: f64) => f64, v: f64): f64 {
  "use owned";
  return applyRt(f, v);
}

// expect: E4005 @ 6:10
// stage: 2
// open-question: Q189
function applyRt(f: (x: f64) => f64, v: f64): f64 {
  "use rt";
  return f(v);
}
function loop(x: f64): f64 {
  "use rt";
  return applyRt(loop, x);
}

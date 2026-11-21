// expect: ok
// stage: 2
// open-question: Q189
function inc(x: f64): f64 {
  "use owned";
  return x + 1;
}
function dbl(x: f64): f64 {
  "use rt";
  return x + x;
}
function applyTwice(f: (x: f64) => f64, v: f64): f64 {
  "use owned";
  return f(f(v));
}
function runIt(v: f64): f64 {
  "use owned";
  return applyTwice(inc, v) + applyTwice(dbl, v);
}

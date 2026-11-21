// expect: ok
// stage: 2
// open-question: Q189
function inc(x: f64): f64 {
  "use owned";
  return x + 1;
}
function rtInc(x: f64): f64 {
  "use rt";
  return x + 1;
}
function inner(f: (x: f64) => f64, v: f64): f64 {
  "use owned";
  return f(v);
}
function outer(f: (x: f64) => f64, v: f64): f64 {
  "use owned";
  return inner(f, v);
}
function rtInner(f: (x: f64) => f64, v: f64): f64 {
  "use rt";
  return f(v);
}
function rtOuter(f: (x: f64) => f64, v: f64): f64 {
  "use rt";
  return rtInner(f, v);
}
test("forward", (t: Test) => {
  t.eq(outer(inc, 1), 2);
  t.eq(rtOuter(rtInc, 1), 2);
});

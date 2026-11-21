// expect: E4003 @ 14:16
// stage: 2
// open-question: Q189
function id<T>(x: T): T {
  "use owned";
  return x;
}
function apply(f: (x: f64) => f64, v: f64): f64 {
  "use owned";
  return f(v);
}
function g(v: f64): f64 {
  "use owned";
  return apply(id, v);
}

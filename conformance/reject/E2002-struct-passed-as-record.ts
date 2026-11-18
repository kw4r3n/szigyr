// expect: E2002 @ 10:14
// stage: 2
// open-question: Q002
type S = Struct<{ readonly x: f64 }>;
type R = { readonly x: f64 };
function get(r: R): f64 {
  return r.x;
}
function f(s: S): f64 {
  return get(s);
}

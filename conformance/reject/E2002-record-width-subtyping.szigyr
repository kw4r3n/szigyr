// expect: E2002 @ 10:17
// stage: 1
// open-question: Q020
type P = { readonly x: f64; readonly y: f64 };
type P3 = { readonly x: f64; readonly y: f64; readonly z: f64 };
function takesP(p: P): f64 {
  return p.x;
}
function f(p3: P3): f64 {
  return takesP(p3);
}

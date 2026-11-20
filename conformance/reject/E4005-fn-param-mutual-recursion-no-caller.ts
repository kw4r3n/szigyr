// expect: E4005 @ 6:10
// stage: 3
// open-question: Q227
function a(f: (x: f64) => f64, n: u32): f64 {
  "use rt";
  return b(f, n);
}
function b(f: (x: f64) => f64, n: u32): f64 {
  "use rt";
  return a(f, n);
}

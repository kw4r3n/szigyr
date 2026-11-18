// expect: E2004 @ 4:10
// stage: 1
function f(s: string): f64 {
  return s ? 1 : 2;
}

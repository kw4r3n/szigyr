// expect: E2004 @ 4:10
// stage: 1
function f(x: f64 | null): f64 {
  while (x) {
    return 1;
  }
  return 0;
}

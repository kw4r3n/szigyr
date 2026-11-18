// expect: E2003 @ 4:19
// stage: 1
function f(a: Array<f64>, n: u32): boolean {
  return a.length < n;
}

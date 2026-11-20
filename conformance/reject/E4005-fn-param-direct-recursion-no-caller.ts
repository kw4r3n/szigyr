// expect: E4005 @ 7:10
// stage: 3
// open-question: Q227
function walk(f: (x: f64) => f64, n: u32): f64 {
  "use rt";
  if (n === 0) { return f(1); }
  return walk(f, n - 1);
}

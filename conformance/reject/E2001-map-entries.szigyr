// expect: E2001 @ 6:21
// stage: 1
// open-question: Q007
function f(m: Map<string, f64>): f64 {
  let t: f64 = 0;
  for (const e of m.entries()) {
    t += 1;
  }
  return t;
}

// expect: E2001 @ 6:21
// stage: 1
// open-question: Q271
function f(): f64 {
  const a = Number.POSITIVE_INFINITY;
  return a + Number.MAX_VALUE;
}

// expect: E2003 @ 6:12
// stage: 1
// open-question: Q014
function f(a: i32): i32 {
  const k = 2;
  return a * k;
}

// expect: E6002 @ 5:13
// stage: 1
// open-question: Q134
function f(xs: Array<i32>): i32 {
  requires((xs[0] = 1) === 1);
  return xs[0];
}

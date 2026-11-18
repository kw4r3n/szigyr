// expect: E2002 @ 6:13
// stage: 1
// open-question: Q032
// open-question: Q083
function has(xs: Array<Array<i32>>, y: Array<i32>): boolean {
  return xs.includes(y);
}

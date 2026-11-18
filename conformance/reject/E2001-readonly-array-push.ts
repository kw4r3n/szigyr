// expect: E2001 @ 5:6
// stage: 1
// open-question: Q032
function f(xs: ReadonlyArray<i32>): void {
  xs.push(1);
}

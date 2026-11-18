// expect: E1000 @ 6:36
// stage: 1
// open-question: Q124
function f(xs: Array<i32>): void {
  while (true) {
    xs.forEach((x: i32): void => { break; });
  }
}

// expect: E2002 @ 5:14
// stage: 1
// open-question: Q125
function f(xs: Array<i32>): void {
  xs.forEach(async (x: i32): Promise<void> => { panic("x"); });
}

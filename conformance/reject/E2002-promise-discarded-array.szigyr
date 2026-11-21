// expect: E2002 @ 8:3
// stage: 1
// open-question: Q125
async function h(x: i32): Promise<void> {
  panic("x");
}
function f(xs: Array<i32>): void {
  xs.map((x: i32) => h(x));
}

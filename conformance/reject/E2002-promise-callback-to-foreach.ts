// expect: E2002 @ 8:14
// stage: 1
// open-question: Q130
async function g(x: i32): Promise<void> {
  panic("late");
}
function f(xs: Array<i32>): void {
  xs.forEach(g);
}

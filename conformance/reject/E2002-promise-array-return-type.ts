// expect: E2002 @ 7:35
// stage: 1
// open-question: Q130
async function g(x: i32): Promise<void> {
  panic("late");
}
function f(xs: Array<i32>): Array<Promise<void>> {
  return xs.map(g);
}

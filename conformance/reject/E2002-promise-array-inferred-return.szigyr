// expect: E2002 @ 8:33
// stage: 1
// open-question: Q130
async function g(x: i32): Promise<void> {
  panic("late");
}
async function f(xs: Array<i32>): Promise<void> {
  const h = (ys: Array<i32>) => ys.map(g);
  await Promise.all(h(xs));
}

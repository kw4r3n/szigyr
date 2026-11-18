// expect: E2003 @ 6:12
// stage: 1
// open-question: Q014
function f(n: usize): boolean {
  const x = 1;
  return x === n;
}

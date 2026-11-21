// expect: E2002 @ 8:17
// stage: 1
// open-question: Q130
async function g(): Promise<i32> {
  return 1;
}
function f(c: boolean): void {
  const p = c ? g() : g();
}

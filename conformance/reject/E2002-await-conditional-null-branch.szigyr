// expect: E2002 @ 8:16
// stage: 1
// open-question: Q130
async function g(): Promise<i32> {
  return 1;
}
async function f(c: boolean): Promise<i32> {
  return await (c ? g() : null) ?? 0;
}

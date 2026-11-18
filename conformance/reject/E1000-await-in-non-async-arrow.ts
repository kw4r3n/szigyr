// expect: E1000 @ 8:24
// stage: 1
// open-question: Q124
async function h(): Promise<i32> {
  return 1;
}
async function f(): Promise<void> {
  const g = (): i32 => await h();
}

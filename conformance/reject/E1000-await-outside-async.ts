// expect: E1000 @ 8:13
// stage: 1
// open-question: Q124
async function h(): Promise<i32> {
  return 1;
}
function f(): void {
  const x = await h();
}

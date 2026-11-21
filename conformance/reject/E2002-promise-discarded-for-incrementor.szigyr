// expect: E2002 @ 8:31
// stage: 1
// open-question: Q125
async function h(): Promise<i32> {
  return 1;
}
function f(): void {
  for (let i: i32 = 0; i < 2; h()) {
    i += 1;
  }
}

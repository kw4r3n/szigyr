// expect: E2002 @ 8:3
// stage: 1
// open-question: Q125
async function h(): Promise<void> {
  panic("x");
}
function f(c: boolean): void {
  c ? h() : null;
}

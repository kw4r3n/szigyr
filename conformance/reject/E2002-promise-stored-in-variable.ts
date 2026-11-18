// expect: E2002 @ 8:13
// stage: 1
// open-question: Q130
async function g(): Promise<void> {
  panic("late");
}
function f(): void {
  const p = g();
}

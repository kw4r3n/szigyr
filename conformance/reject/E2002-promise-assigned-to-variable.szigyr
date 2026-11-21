// expect: E2002 @ 8:10
// stage: 1
// open-question: Q130
async function g(): Promise<void> {
  panic("late");
}
function f(): void {
  let p: Promise<void> | null = null;
  p = g();
}

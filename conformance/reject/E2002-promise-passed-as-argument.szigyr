// expect: E2002 @ 7:18
// stage: 1
// open-question: Q130
async function g(): Promise<void> {
  panic("late");
}
function keep(p: Promise<void>): void {
}
function f(): void {
  keep(g());
}

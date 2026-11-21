// expect: E2002 @ 8:24
// stage: 1
// open-question: Q130
async function g(): Promise<void> {
  panic("late");
}
function f(): void {
  const m: Map<string, Promise<void>> = new Map<string, Promise<void>>();
  m.set("a", g());
}

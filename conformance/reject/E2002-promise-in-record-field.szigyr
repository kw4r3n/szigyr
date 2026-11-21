// expect: E2002 @ 7:24
// stage: 1
// open-question: Q130
async function g(): Promise<void> {
  panic("late");
}
type R = { readonly p: Promise<void> };
function f(): void {
  const r: R = { p: g() };
}

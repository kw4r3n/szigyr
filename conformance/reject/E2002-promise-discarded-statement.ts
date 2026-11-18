// expect: E2002 @ 8:3
// stage: 1
// open-question: Q125
async function g(): Promise<void> {
  panic("late");
}
function f(log: Log): void {
  g();
  log.info("done");
}

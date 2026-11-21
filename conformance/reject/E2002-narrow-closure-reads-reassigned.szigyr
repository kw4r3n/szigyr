// expect: E2002 @ 7:30
// stage: 1
// open-question: Q122
function f(log: Log): void {
  let x: string | null = "a";
  if (x !== null) {
    const g = (): usize => x.length;
    x = null;
    log.info(`${g()}`);
  }
}

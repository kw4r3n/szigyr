// expect: E2002 @ 9:19
// stage: 1
// open-question: Q122
function f(log: Log): void {
  let x: string | null = "a";
  const g = (): void => { x = null; };
  if (x !== null) {
    g();
    log.info(`${x.length}`);
  }
}

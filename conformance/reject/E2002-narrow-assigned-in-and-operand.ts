// expect: E2002 @ 8:19
// stage: 1
// open-question: Q122
function f(log: Log, b: boolean): void {
  let x: string | null = "a";
  if (x !== null) {
    const c = b && (x = null) === null;
    log.info(`${x.length}`);
  }
}

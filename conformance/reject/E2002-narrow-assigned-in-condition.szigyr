// expect: E2002 @ 6:58
// stage: 1
// open-question: Q122
function f(log: Log): void {
  let x: string | null = "a";
  if (x !== null && (x = null) === null) { log.info(`${x.length}`); }
}

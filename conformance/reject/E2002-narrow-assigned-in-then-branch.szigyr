// expect: E2002 @ 7:17
// stage: 1
// open-question: Q122
function f(log: Log): void {
  let x: string | null = "a";
  if (x !== null) { x = null; } else { return; }
  log.info(`${x.length}`);
}

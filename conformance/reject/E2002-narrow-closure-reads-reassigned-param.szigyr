// expect: E2002 @ 6:28
// stage: 1
// open-question: Q122
function h(x: string | null, log: Log): void {
  if (x === null) return;
  const g = (): usize => x.length;
  x = null;
  log.info(`${g()}`);
}

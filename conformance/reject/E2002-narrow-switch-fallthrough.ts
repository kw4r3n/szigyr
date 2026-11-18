// expect: E2002 @ 9:31
// stage: 1
// open-question: Q122
function f(log: Log, k: string): void {
  let x: string | null = "a";
  if (x !== null) {
    switch (k) {
      case "a": x = null;
      case "b": log.info(`${x.length}`); break;
      default: break;
    }
  }
}

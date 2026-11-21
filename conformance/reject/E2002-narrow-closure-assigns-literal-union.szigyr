// expect: E2002 @ 10:20
// stage: 1
// open-question: Q122
type C = "a" | "b";
function f(log: Log): void {
  let c: C = "a";
  const g = (): void => { c = "b"; };
  if (c === "a") {
    g();
    const d: "a" = c;
    log.info(d);
  }
}

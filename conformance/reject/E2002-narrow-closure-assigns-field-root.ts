// expect: E2002 @ 10:21
// stage: 1
// open-question: Q122
type R = { readonly a: string | null };
function f(log: Log): void {
  let r: R = { a: "x" };
  const s = (): void => { r = { a: null }; };
  if (r.a !== null) {
    s();
    log.info(`${r.a.length}`);
  }
}

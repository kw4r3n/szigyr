// expect: E2002 @ 6:13
// stage: 1
// open-question: Q128
function f(js: Js, log: Log): JsRef {
  const g = (): void => { log.info("x"); };
  return js.encode(g);
}

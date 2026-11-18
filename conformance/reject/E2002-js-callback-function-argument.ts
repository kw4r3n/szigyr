// expect: E2002 @ 5:22
// stage: 1
// open-question: Q128
function f(js: Js): JsRef {
  return js.callback<() => void>((r: Result<() => void, CastError>): void => {});
}

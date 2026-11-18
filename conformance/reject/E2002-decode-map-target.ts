// expect: E2002 @ 5:20
// stage: 1
// open-question: Q084
function f(js: Js, v: JsRef): Result<Map<string, i32>, CastError> {
  return js.decode<Map<string, i32>>(v);
}

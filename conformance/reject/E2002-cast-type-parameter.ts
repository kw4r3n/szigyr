// expect: E2002 @ 5:15
// stage: 1
// open-question: Q084
function f<T>(x: unknown): Result<T, CastError> {
  return cast<T>(x);
}

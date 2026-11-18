// expect: E2002 @ 8:15
// stage: 1
// open-question: Q084
class Box {
  readonly v: i32 = 0;
}
function f(x: unknown): Result<Box, CastError> {
  return cast<Box>(x);
}

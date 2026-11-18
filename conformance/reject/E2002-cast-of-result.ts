// expect: E2002 @ 5:20
// stage: 2
// open-question: Q182
function f(text: string): Result<u32, CastError> {
  return cast<u32>(JSON.parse(text));
}

// expect: ok
// stage: 2
// open-question: Q185
function f(text: string): Result<u32, CastError> {
  const r = JSON.parse(text);
  if (r.kind === "err") return err({ code: r.error.code, message: r.error.message });
  return cast<u32>(r.value);
}

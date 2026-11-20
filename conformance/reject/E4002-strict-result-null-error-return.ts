// expect: E4002 @ 4:15
// stage: 3
// open-question: Q233
function g(): Result<i32, null> {
  "use owned";
  return ok(1);
}

// expect: E2002 @ 5:11
// stage: 1
// open-question: Q129
function f(x: i32): void {
  ensures((r: i32): boolean => x > 0);
}

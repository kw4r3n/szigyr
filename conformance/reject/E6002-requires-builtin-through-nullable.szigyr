// expect: E6002 @ 5:30
// stage: 3
// open-question: Q232
function f(xs: Array<i32> | null): i32 {
  requires(xs === null || xs.pop() === null);
  return 1;
}

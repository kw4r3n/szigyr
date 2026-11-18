// expect: E6001 @ 6:3
// stage: 1
// open-question: Q057
export function f(x: i32): i32 {
  ensures((r: i32) => r > 0);
  requires(x > 0);
  return x;
}

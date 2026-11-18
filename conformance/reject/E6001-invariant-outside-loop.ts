// expect: E6001 @ 5:3
// stage: 1
// open-question: Q057
export function f(n: i32): i32 {
  invariant(n > 0);
  return n;
}

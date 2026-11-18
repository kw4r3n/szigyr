// expect: E6001 @ 8:5
// stage: 1
// open-question: Q057
export function f(n: i32): i32 {
  let i: i32 = 0;
  while (i < n) {
    i += 1;
    invariant(i > 0);
  }
  return i;
}

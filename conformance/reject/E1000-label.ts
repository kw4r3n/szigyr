// expect: E1000 @ 6:3
// stage: 1
// open-question: Q004
export function f(n: i32): i32 {
  let i: i32 = 0;
  outer: while (i < n) {
    i += 1;
  }
  return i;
}

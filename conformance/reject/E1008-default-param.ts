// expect: E1008 @ 4:27
// stage: 1
// open-question: Q005
export function f(a: i32, b: i32 = 1): i32 {
  return a;
}

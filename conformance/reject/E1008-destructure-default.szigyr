// expect: E1008 @ 6:11
// stage: 1
// open-question: Q052
type P = { readonly x: i32 };
export function f(p: P): i32 {
  const { x = 1 } = p;
  return x;
}

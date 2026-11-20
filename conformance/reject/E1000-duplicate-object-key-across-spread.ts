// expect: E1000 @ 6:24
// stage: 3
// open-question: Q223
type R = { readonly a: i32 };
export function f(s: R): R {
  return { a: 1, ...s, a: 9 };
}

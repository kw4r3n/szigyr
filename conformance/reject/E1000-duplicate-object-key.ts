// expect: E1000 @ 6:18
// stage: 1
// open-question: Q223
type R = { readonly a: i32 };
export function f(): R {
  return { a: 1, a: 2 };
}

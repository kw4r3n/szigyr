// expect: E2002 @ 5:19
// stage: 1
// open-question: Q081
type P = { readonly x: i32 };
function f(s: Set<P>): void {}

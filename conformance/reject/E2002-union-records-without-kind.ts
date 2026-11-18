// expect: E2002 @ 4:13
// stage: 1
// open-question: Q080
type Pair = { readonly a: i32 } | { readonly b: i32 };
function show(p: Pair): void {}

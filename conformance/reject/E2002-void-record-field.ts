// expect: E2002 @ 4:24
// stage: 1
// open-question: Q028
type R = { readonly a: void };
function f(r: R): void {}

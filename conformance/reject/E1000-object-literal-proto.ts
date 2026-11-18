// expect: E1000 @ 6:18
// stage: 1
// open-question: Q123
type R = { readonly x: f64 };
function f(): void {
  const r: R = { __proto__: 1, x: 1 };
}

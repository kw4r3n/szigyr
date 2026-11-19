// expect: E2001 @ 7:5
// stage: 2
// open-question: Q007
// open-question: Q188
function f(a: Mut<Arena>): void {
  "use owned";
  a.clear();
}

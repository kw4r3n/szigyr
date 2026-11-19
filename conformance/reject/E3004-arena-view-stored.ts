// expect: E3004 @ 6:15
// stage: 2
// open-question: Q188
function f(a: Mut<Arena>, b: ArenaBuf<f32>): void {
  "use rt";
  const s = a.view(b);
}

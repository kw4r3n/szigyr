// expect: E3005 @ 9:19
// stage: 2
// open-question: Q188
function both(s: Mut<Slice<f32>>, a: Mut<Arena>): void {
  "use rt";
}
function g(a: Arena, b: ArenaBuf<f32>): void {
  "use owned";
  both(a.view(b), a);
}

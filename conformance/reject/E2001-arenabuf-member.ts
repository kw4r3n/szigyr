// expect: E2001 @ 7:12
// stage: 2
// open-question: Q007
// open-question: Q188
function f(b: ArenaBuf<f32>): u32 {
  "use owned";
  return b.gen;
}

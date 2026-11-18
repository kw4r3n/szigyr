// expect: E2008 @ 5:18
// stage: 1
// open-question: Q015
function f(): f32 {
  const x: f32 = 1e39;
  return x;
}

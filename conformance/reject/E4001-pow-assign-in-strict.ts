// expect: E4001 @ 8:5
// stage: 2
// open-question: Q002
// open-question: Q180
function sq(x: f32): f32 {
  "use owned";
  let y: f32 = x;
  y **= 2;
  return y;
}

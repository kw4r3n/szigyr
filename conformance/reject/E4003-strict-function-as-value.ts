// expect: E4003 @ 10:17
// stage: 2
// open-question: Q045
function dbl(x: f32): f32 {
  "use owned";
  return x + x;
}
function m(): Array<f32> {
  const xs: Array<f32> = [1, 2];
  return xs.map(dbl);
}

// expect: E4001 @ 6:15
// stage: 1
// open-question: Q044
function f(x: f64): f64 {
  "use owned";
  return Math.sin(x);
}

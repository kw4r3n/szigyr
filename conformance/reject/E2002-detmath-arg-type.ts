// expect: E2002 @ 5:22
// stage: 2
function f(x: f32): f64 {
  "use rt";
  return DetMath.sin(x);
}

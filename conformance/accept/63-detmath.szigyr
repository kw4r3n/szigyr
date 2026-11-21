// expect: ok
// stage: 2
function inRt(x: f64): f64 {
  "use rt";
  return DetMath.sin(x) + DetMath.pow(x, 2);
}
function inStrict(x: f64): f64 {
  "use owned";
  return DetMath.atan2(x, 1) + DetMath.log10(x);
}
function inManaged(x: f64): f64 {
  return DetMath.exp(x) + DetMath.log(x) + DetMath.tanh(x) + DetMath.cos(x) + DetMath.tan(x) + DetMath.atan(x);
}
function f32Use(x: f32): f32 {
  "use rt";
  return f32(DetMath.sin(f64(x)));
}
export function useAll(x: f64): f64 {
  return inRt(x) + inStrict(x) + inManaged(x) + f64(f32Use(f32(x)));
}

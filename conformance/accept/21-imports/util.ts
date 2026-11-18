export const SCALE: f64 = 2;

export function clamp01(x: f64): f64 {
  if (x < 0) {
    return 0;
  }
  if (x > 1) {
    return 1;
  }
  return x;
}

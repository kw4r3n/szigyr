// expect: E6002 @ 14:41
// stage: 2
// open-question: Q175
function eat(v: Vec<f32>): usize {
  "use owned";
  return v.length;
}
function mk(alloc: Alloc): Vec<f32> {
  "use owned";
  return Vec.create<f32>(alloc, 2);
}
function f(alloc: Alloc): Vec<f32> {
  "use owned";
  ensures((r: Vec<f32>): boolean => eat(r) === 0);
  return mk(alloc);
}

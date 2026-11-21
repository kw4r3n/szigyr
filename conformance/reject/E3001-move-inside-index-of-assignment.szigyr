// expect: E3001 @ 15:3
// stage: 2
// open-question: Q170
function eat(v: Vec<f32>): usize {
  "use owned";
  return v.length;
}
function mk(alloc: Alloc): Vec<f32> {
  "use owned";
  return Vec.create<f32>(alloc, 2);
}
function f(alloc: Alloc): void {
  "use owned";
  const a = mk(alloc);
  a[eat(a)] = 1;
}

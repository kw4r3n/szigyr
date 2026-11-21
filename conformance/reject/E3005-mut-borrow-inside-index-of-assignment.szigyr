// expect: E3005 @ 16:8
// stage: 2
// open-question: Q170
function wn(v: Mut<Vec<f32>>): usize {
  "use owned";
  v.push(1);
  return 0;
}
function mk(alloc: Alloc): Vec<f32> {
  "use owned";
  return Vec.create<f32>(alloc, 2);
}
function f(alloc: Alloc): void {
  "use owned";
  const a = mk(alloc);
  a[wn(a)] = 1;
}

// expect: E3005 @ 12:13
// stage: 2
// open-question: Q170
function wn(v: Mut<Vec<f32>>): f32 {
  "use owned";
  v.push(1);
  return 0;
}
function f(alloc: Alloc): void {
  "use owned";
  const v = Vec.create<f32>(alloc, 2);
  v.fill(wn(v));
}

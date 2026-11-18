// expect: E3001 @ 11:10
// stage: 2
function take(v: Vec<f32>): boolean {
  "use owned";
  return true;
}
function f(alloc: Alloc, c: boolean): usize {
  "use owned";
  const a = Vec.create<f32>(alloc, 4);
  const r = c && take(a);
  return a.length;
}

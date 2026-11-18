// expect: E3001 @ 9:10
// stage: 2
function f(alloc: Alloc, c: boolean): usize {
  "use owned";
  const a = Vec.create<f32>(alloc, 4);
  if (c) {
    const b = a;
  }
  return a.length;
}

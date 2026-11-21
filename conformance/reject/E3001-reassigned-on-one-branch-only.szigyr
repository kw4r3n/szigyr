// expect: E3001 @ 10:10
// stage: 2
function f(alloc: Alloc, c: boolean): usize {
  "use owned";
  let a = Vec.create<f32>(alloc, 4);
  const b = a;
  if (c) {
    a = Vec.create<f32>(alloc, 2);
  }
  return a.length;
}

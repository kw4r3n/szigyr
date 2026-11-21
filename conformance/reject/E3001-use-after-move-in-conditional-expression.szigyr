// expect: E3001 @ 7:10
// stage: 2
function f(alloc: Alloc, c: boolean): usize {
  "use owned";
  const a = Vec.create<f32>(alloc, 4);
  const b = c ? a : Vec.create<f32>(alloc, 2);
  return a.length;
}

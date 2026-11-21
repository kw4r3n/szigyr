// expect: E3007 @ 10:17
// stage: 2
// open-question: Q174
function mk(alloc: Alloc): Vec<f32> {
  "use owned";
  return Vec.create<f32>(alloc, 2);
}
function f(alloc: Alloc): usize {
  const xs: Array<u32> = [1, 2];
  const vs = xs.map((x: u32): Vec<f32> => mk(alloc));
  return vs.length;
}

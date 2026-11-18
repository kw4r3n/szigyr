// expect: E3007 @ 14:17
// stage: 2
// open-question: Q174
function mk(alloc: Alloc): Vec<f32> {
  "use owned";
  return Vec.create<f32>(alloc, 2);
}
function eat(v: Vec<f32>): usize {
  "use owned";
  return v.length;
}
function f(al: Alloc): usize {
  const ys: Array<Array<Vec<f32>>> = [[]];
  const zs = ys.map((y: Array<Vec<f32>>): Vec<f32> => mk(al));
  return eat(zs[0]) + eat(zs[0]);
}

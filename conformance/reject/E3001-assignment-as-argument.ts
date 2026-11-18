// expect: E3001 @ 17:14
// stage: 2
// open-question: Q172
function eat(v: Vec<f32>): usize {
  "use owned";
  return v.length;
}
function mk(alloc: Alloc): Vec<f32> {
  "use owned";
  return Vec.create<f32>(alloc, 2);
}
function f(alloc: Alloc): usize {
  "use owned";
  let a = mk(alloc);
  const c = mk(alloc);
  const n = eat(a = c);
  return n + a.length;
}

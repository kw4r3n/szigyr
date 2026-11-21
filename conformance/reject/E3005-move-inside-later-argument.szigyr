// expect: E3005 @ 19:19
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
function m(a: Ref<Vec<f32>>, n: usize): usize {
  "use owned";
  return a.length + n;
}
function f(alloc: Alloc): usize {
  "use owned";
  const a = mk(alloc);
  return m(a, eat(a));
}

// expect: E3001 @ 13:21
// stage: 2
// open-question: Q172
function mk(alloc: Alloc): Vec<f32> {
  "use owned";
  return Vec.create<f32>(alloc, 2);
}
function f(alloc: Alloc): usize {
  "use owned";
  let a = mk(alloc);
  const c = mk(alloc);
  const d = (a = c);
  return d.length + a.length;
}

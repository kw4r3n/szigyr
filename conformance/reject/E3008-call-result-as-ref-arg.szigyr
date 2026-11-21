// expect: E3008 @ 14:14
// stage: 2
// open-question: Q002
function make(alloc: Alloc): Vec<f32> {
  "use owned";
  return Vec.create<f32>(alloc, 1);
}
function len(v: Ref<Vec<f32>>): usize {
  "use owned";
  return v.length;
}
function f(alloc: Alloc): usize {
  "use owned";
  return len(make(alloc));
}

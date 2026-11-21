// expect: E3008 @ 10:14
// stage: 2
// open-question: Q002
function len(v: Ref<Vec<f32>>): usize {
  "use owned";
  return v.length;
}
function f(alloc: Alloc): usize {
  "use owned";
  return len(Vec.create<f32>(alloc, 1));
}

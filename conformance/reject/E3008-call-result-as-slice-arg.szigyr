// expect: E3008 @ 14:16
// stage: 2
// open-question: Q002
function make(alloc: Alloc): Vec<f32> {
  "use owned";
  return Vec.create<f32>(alloc, 1);
}
function first(s: Ref<Slice<f32>>): f32 {
  "use rt";
  return s[0];
}
function f(alloc: Alloc): f32 {
  "use owned";
  return first(make(alloc));
}

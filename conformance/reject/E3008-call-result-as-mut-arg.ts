// expect: E3008 @ 14:9
// stage: 2
// open-question: Q002
function make(alloc: Alloc): Vec<f32> {
  "use owned";
  return Vec.create<f32>(alloc, 1);
}
function clear(v: Mut<Vec<f32>>): void {
  "use owned";
  v.clear();
}
function f(alloc: Alloc): void {
  "use owned";
  clear(make(alloc));
}

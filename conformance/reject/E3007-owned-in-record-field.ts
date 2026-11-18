// expect: E3007 @ 7:23
// stage: 2
// open-question: Q048
type Box = { readonly v: Vec<f32> };
function f(alloc: Alloc): Box {
  const a = Vec.create<f32>(alloc, 1);
  const b: Box = { v: a };
  return b;
}

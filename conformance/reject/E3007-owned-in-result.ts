// expect: E3007 @ 5:13
// stage: 2
// open-question: Q048
function f(alloc: Alloc): Result<Vec<f32>, string> {
  return ok(Vec.create<f32>(alloc, 1));
}

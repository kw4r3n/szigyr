// expect: E3007 @ 7:14
// stage: 2
// open-question: Q048
function f(alloc: Alloc): void {
  const m = new Map<string, Vec<f32>>();
  const a = Vec.create<f32>(alloc, 1);
  m.set("a", a);
}

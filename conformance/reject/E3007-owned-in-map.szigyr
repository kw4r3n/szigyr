// expect: E3007 @ 7:29
// stage: 2
// open-question: Q174
// open-question: Q048
// open-question: Q029
function f(alloc: Alloc): void {
  const m = new Map<string, Vec<f32>>();
  const a = Vec.create<f32>(alloc, 1);
  m.set("a", a);
}

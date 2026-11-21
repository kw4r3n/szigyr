// expect: E4003 @ 7:13
// stage: 2
// open-question: Q012
function f(alloc: Alloc): void {
  "use owned";
  const a = Vec.create<f32>(alloc, 1);
  const g = (): usize => a.length;
}

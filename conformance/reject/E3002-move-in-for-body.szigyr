// expect: E3002 @ 8:15
// stage: 2
// open-question: Q002
function f(alloc: Alloc, n: usize): void {
  "use owned";
  const a = Vec.create<f32>(alloc, 4);
  for (let i: usize = 0; i < n; i += 1) {
    const b = a;
  }
}

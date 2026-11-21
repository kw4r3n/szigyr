// expect: E3002 @ 12:15
// stage: 2
// open-question: Q002
function consume(v: Vec<f32>): void {
  "use owned";
}
function f(alloc: Alloc, n: usize): void {
  "use owned";
  for (let i: usize = 0; i < n; i += 1) {
    const a = Vec.create<f32>(alloc, 4);
    for (let j: usize = 0; j < n; j += 1) {
      consume(a);
    }
  }
}

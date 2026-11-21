// expect: E3002 @ 12:13
// stage: 2
// open-question: Q002
// open-question: Q150
function consume(v: Vec<f32>): void {
  "use owned";
}
function f(alloc: Alloc, n: usize, c: boolean): void {
  "use owned";
  let a = Vec.create<f32>(alloc, 4);
  for (let i: usize = 0; i < n; i += 1) {
    consume(a);
    if (c) {
      a = Vec.create<f32>(alloc, 4);
    }
  }
}

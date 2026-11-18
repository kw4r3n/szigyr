// expect: E3002 @ 12:13
// stage: 2
// open-question: Q002
function consume(v: Vec<f32>): void {
  "use owned";
}
function f(alloc: Alloc, n: usize): void {
  "use owned";
  const a = Vec.create<f32>(alloc, 4);
  let i: usize = 0;
  while (i < n) {
    consume(a);
    i += 1;
  }
}

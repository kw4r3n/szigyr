// expect: E3001 @ 10:3
// stage: 2
function consume(v: Vec<f32>): void {
  "use owned";
}
function f(alloc: Alloc): void {
  "use owned";
  const a = Vec.create<f32>(alloc, 4);
  consume(a);
  a.push(1);
}

// expect: E3005 @ 20:12
// stage: 2
// open-question: Q170
function mk(alloc: Alloc): Vec<f32> {
  "use owned";
  return Vec.create<f32>(alloc, 2);
}
type W = Struct<{ a: Vec<f32>; b: Vec<f32> }>;
function g(w: W): usize {
  "use owned";
  return w.a.length;
}
function m(a: Mut<Vec<f32>>, n: usize): void {
  "use owned";
  a.push(f32(n));
}
function f(alloc: Alloc): void {
  "use owned";
  const w: W = { a: mk(alloc), b: mk(alloc) };
  m(w.a, g(w));
}

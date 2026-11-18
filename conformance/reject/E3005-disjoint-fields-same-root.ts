// expect: E3005 @ 10:14
// stage: 2
// open-question: Q002
type Pair = Struct<{ a: Vec<f32>; b: Vec<f32> }>;
function copyV(dst: Mut<Vec<f32>>, src: Ref<Vec<f32>>): void {
  "use owned";
}
function g(p: Mut<Pair>): void {
  "use owned";
  copyV(p.a, p.b);
}

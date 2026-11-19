// expect: E3005 @ 11:17
// stage: 2
// open-question: Q190
type Inner = Struct<{ x: Vec<f32>; y: Vec<f32> }>;
type Outer = Struct<{ inner: Inner; other: Vec<f32> }>;
function both(s: Mut<Inner>, v: Mut<Vec<f32>>): void {
  "use owned";
}
function g(o: Mut<Outer>): void {
  "use owned";
  both(o.inner, o.inner.x);
}

// expect: E4002 @ 7:21
// stage: 2
// open-question: Q086
// open-question: Q188
function f(a: Mut<Arena>, v: Vec<f32>): void {
  "use owned";
  const b = a.alloc<Vec<f32>>(1, v);
}

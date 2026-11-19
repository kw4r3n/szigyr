// expect: E3005 @ 9:11
// stage: 2
// open-question: Q188
function both(p: Mut<Pool<f32>>, q: Ref<Pool<f32>>): void {
  "use rt";
}
function g(p: Pool<f32>): void {
  "use owned";
  both(p, p);
}

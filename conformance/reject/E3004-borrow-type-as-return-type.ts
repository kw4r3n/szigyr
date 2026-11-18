// expect: E3004 @ 4:31
// stage: 2
// open-question: Q002
function f(v: Ref<Vec<f32>>): Ref<Vec<f32>> {
  panic("unreachable");
}

// expect: E3004 @ 4:21
// stage: 2
// open-question: Q171
async function h(a: Mut<Vec<f32>>): Promise<void> {
}
async function f(v: Mut<Vec<f32>>): Promise<void> {
  await Promise.all([h(v), h(v)]);
}

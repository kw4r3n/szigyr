// expect: E2002 @ 7:19
// stage: 2
// open-question: Q002
function total(v: Ref<Vec<f32>>): f32 {
  "use rt";
  let acc: f32 = 0;
  for (const x of v) {
    acc += x;
  }
  return acc;
}

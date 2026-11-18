// expect: E4004 @ 7:7
// stage: 2
// open-question: Q002
function p(v: Mut<Vec<f32>>, n: usize): void {
  "use rt";
  for (let i: usize = 0; i < n; i += 1) {
    v.push(0);
  }
}

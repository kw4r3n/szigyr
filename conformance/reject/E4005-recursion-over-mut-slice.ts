// expect: E4005 @ 8:5
// stage: 2
// open-question: Q046
function fill(v: Mut<Slice<f32>>, i: usize): void {
  "use rt";
  if (i < v.length) {
    v[i] = 0;
    fill(v, i + 1);
  }
}

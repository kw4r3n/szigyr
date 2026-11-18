// expect: E3006 @ 6:5
// stage: 2
// open-question: Q050
function g(v: Ref<Vec<f32>>): void {
  "use owned";
  v.push(1);
}

// expect: E3006 @ 9:5
// stage: 2
// open-question: Q050
function w(v: Mut<Vec<f32>>): void {
  "use owned";
}
function g(v: Ref<Vec<f32>>): void {
  "use owned";
  w(v);
}

// expect: E6002 @ 11:15
// stage: 2
// open-question: Q175
function wn(v: Mut<Vec<f32>>): usize {
  "use owned";
  v.push(1);
  return 0;
}
function f(v: Mut<Vec<f32>>): void {
  "use owned";
  requires(wn(v) === 0);
}

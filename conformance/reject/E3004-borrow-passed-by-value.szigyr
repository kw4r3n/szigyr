// expect: E3004 @ 9:11
// stage: 2
// open-question: Q064
function consume(v: Vec<f32>): void {
  "use owned";
}
function g(v: Mut<Vec<f32>>): void {
  "use owned";
  consume(v);
}

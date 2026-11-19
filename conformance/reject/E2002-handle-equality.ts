// expect: E2002 @ 7:12
// stage: 2
// open-question: Q017
// open-question: Q188
function f(a: Handle<f32>, b: Handle<f32>): boolean {
  "use owned";
  return a === b;
}

// expect: E2002 @ 4:10
// stage: 1
// open-question: Q023
function f(x: boolean): f64 {
  if (x) {
    return 1;
  }
}

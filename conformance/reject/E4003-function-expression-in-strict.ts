// expect: E4003 @ 6:13
// stage: 2
// open-question: Q012
function f(): void {
  "use owned";
  const g = function (x: f32): f32 {
    return x;
  };
}

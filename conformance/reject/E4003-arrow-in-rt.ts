// expect: E4003 @ 6:13
// stage: 2
// open-question: Q012
function f(): void {
  "use rt";
  const g = (x: f32): f32 => x;
}

// expect: E4002 @ 7:13
// stage: 2
// open-question: Q027
// open-question: Q042
function f(): void {
  "use owned";
  const s = "hi";
}

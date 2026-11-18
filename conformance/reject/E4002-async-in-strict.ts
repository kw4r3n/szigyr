// expect: E4002 @ 5:1
// stage: 2
// open-question: Q002
// open-question: Q069
async function f(): Promise<void> {
  "use owned";
}

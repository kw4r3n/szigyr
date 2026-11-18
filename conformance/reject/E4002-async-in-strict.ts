// expect: E4002 @ 4:1
// stage: 2
// open-question: Q002
async function f(): Promise<void> {
  "use owned";
}

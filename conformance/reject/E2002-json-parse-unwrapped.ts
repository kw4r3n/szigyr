// expect: E2002 @ 5:21
// stage: 1
// open-question: Q035
function f(text: string): string {
  const s: string = JSON.parse(text);
  return s;
}

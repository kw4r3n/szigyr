// expect: E2002 @ 5:15
// stage: 1
// open-question: Q084
function f(m: Map<string, i32>): string {
  return JSON.stringify(m);
}

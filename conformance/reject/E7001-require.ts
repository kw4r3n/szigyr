// expect: E7001 @ 5:3
// stage: 1
// open-question: Q009
export function f(): void {
  require("./a.ts");
}

// expect: E2012 @ 4:17
// stage: 3
// open-question: Q238
type T = "ok" | "a\udc00";
export function main(sys: System): void {
  const x: T = "ok";
}

// expect: E4002 @ 10:13
// stage: 3
// open-question: Q238
// a lone-surrogate string value passed to a strict generic function is inferred as `string` (not a literal type), which strict code rejects
function id<T>(x: T): T {
  "use owned";
  return x;
}
export function main(sys: System): void {
  const y = id("\ud800");
}

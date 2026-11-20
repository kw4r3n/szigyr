// expect: E4002 @ 9:5
// stage: 3
// open-question: Q233
function f<T>(x: i32): T {
  "use owned";
  return panic("x");
}
export function main(sys: System): void {
  f<null>(1);
}

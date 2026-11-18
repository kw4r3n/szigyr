// expect-output: body
// expect-trap: T005 @ 6:3
// stage: 1
// open-question: Q129
function f(x: i32, log: Log): void {
  ensures((): boolean => x > 100);
  log.info("body");
}
export function main(sys: System): void {
  f(1, sys.log);
}

// expect: E4002 @ 9:6
// stage: 3
// open-question: Q233
function id<T>(x: T): T {
  "use owned";
  return x;
}
export function main(sys: System): void {
  id<Result<null, i32>>(ok(null));
  sys.log.info("done");
}

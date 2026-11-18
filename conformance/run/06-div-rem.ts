// expect-output: 7,2 -> 3 1
// expect-output: -7,2 -> -3 -1
// expect-output: 7,-2 -> -3 1
// expect-output: -7,-2 -> 3 -1
// expect-output: 6,3 -> 2 0
// expect-output: -1,2 -> 0 -1
// expect-output: -2147483648,7 -> -306783378 -2
// expect-output: -42 -2
// stage: 1
// open-question: Q014
// open-question: Q027
// open-question: Q059
// open-question: Q015
function show(a: i32, b: i32): string {
  return `${a},${b} -> ${divTrunc(a, b)} ${rem(a, b)}`;
}
export function main(sys: System): void {
  sys.log.info(show(7, 2));
  sys.log.info(show(-7, 2));
  sys.log.info(show(7, -2));
  sys.log.info(show(-7, -2));
  sys.log.info(show(6, 3));
  sys.log.info(show(-1, 2));
  const lo: i32 = -2147483648;
  sys.log.info(show(lo, 7));
  const x: i8 = -128;
  const y: i8 = 3;
  sys.log.info(`${divTrunc(x, y)} ${rem(x, y)}`);
}

// expect-output: 3
// expect-trap: T007 @ 7:10
// stage: 1
// open-question: Q002
// open-question: Q059
function ratio(a: i32, b: i32): i32 {
  return divTrunc(a, b);
}

export function main(sys: System): void {
  sys.log.info(`${ratio(9, 3)}`);
  const zero: i32 = 0;
  sys.log.info(`${ratio(9, zero)}`);
}

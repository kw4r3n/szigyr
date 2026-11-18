// expect-output: -5
// expect-trap: T001 @ 7:10
// stage: 1
// open-question: Q002
// open-question: Q059
function flip(x: i32): i32 {
  return -x;
}

export function main(sys: System): void {
  sys.log.info(`${flip(5)}`);
  const lowest: i32 = -2147483648;
  sys.log.info(`${flip(lowest)}`);
}

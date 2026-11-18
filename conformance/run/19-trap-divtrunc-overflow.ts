// expect-output: -14
// expect-trap: T001 @ 10:10
// stage: 1
// open-question: Q060
// open-question: Q059
// open-question: Q027
// open-question: Q014
// open-question: Q015
function quot(a: i8, b: i8): i8 {
  return divTrunc(a, b);
}

export function main(sys: System): void {
  sys.log.info(`${quot(-100, 7)}`);
  const lowest: i8 = -128;
  const minusOne: i8 = -1;
  sys.log.info(`${quot(lowest, minusOne)}`);
}

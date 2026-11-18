// expect-output: 6
// expect-trap: T006 @ 8:5
// stage: 1
// open-question: Q002
// open-question: Q059
function doubled(n: i32): i32 {
  if (n < 0) {
    panic("negative input");
  }
  return n * 2;
}

export function main(sys: System): void {
  sys.log.info(`${doubled(3)}`);
  const neg: i32 = -3;
  sys.log.info(`${doubled(neg)}`);
}

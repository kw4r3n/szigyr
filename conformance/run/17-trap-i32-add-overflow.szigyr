// expect-output: 2147483647
// expect-trap: T001 @ 9:12
// stage: 1
// open-question: Q002
// open-question: Q059
// open-question: Q027
// open-question: Q014
function bump(x: i32): i32 {
  return x + 1;
}

export function main(sys: System): void {
  const near: i32 = 2147483646;
  const top: i32 = bump(near);
  sys.log.info(`${top}`);
  sys.log.info(`${bump(top)}`);
}

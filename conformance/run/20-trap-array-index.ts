// expect-output: 30
// expect-trap: T002 @ 9:13
// stage: 1
// open-question: Q002
// open-question: Q059
// open-question: Q027
// open-question: Q014
function at(xs: Array<i32>, i: usize): i32 {
  return xs[i];
}

export function main(sys: System): void {
  const xs: Array<i32> = [10, 20, 30];
  sys.log.info(`${at(xs, 2)}`);
  sys.log.info(`${at(xs, xs.length)}`);
}

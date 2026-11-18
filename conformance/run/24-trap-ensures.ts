// expect-output: 3
// expect-trap: T005 @ 8:3
// stage: 1
// open-question: Q002
// open-question: Q056
// open-question: Q059
function absDiff(a: i32, b: i32): i32 {
  ensures((r: i32) => r >= 0);
  return a - b;
}

export function main(sys: System): void {
  sys.log.info(`${absDiff(5, 2)}`);
  sys.log.info(`${absDiff(2, 5)}`);
}

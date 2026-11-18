// expect-output: i=0
// expect-output: i=1
// expect-output: i=2
// expect-trap: T010 @ 12:5
// stage: 1
// open-question: Q002
// open-question: Q057
// open-question: Q059
export function main(sys: System): void {
  let i: i32 = 0;
  while (i < 5) {
    invariant(i < 3);
    sys.log.info(`i=${i}`);
    i += 1;
  }
}

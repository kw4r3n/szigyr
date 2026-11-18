// expect-output: 4
// expect-trap: T004 @ 10:3
// stage: 1
// open-question: Q002
// open-question: Q057
// open-question: Q059
// open-question: Q027
// open-question: Q014
function isqrt(n: i32): i32 {
  requires(n >= 0);
  let r: i32 = 0;
  while ((r + 1) * (r + 1) <= n) {
    r += 1;
  }
  return r;
}

export function main(sys: System): void {
  sys.log.info(`${isqrt(17)}`);
  const neg: i32 = -1;
  sys.log.info(`${isqrt(neg)}`);
}

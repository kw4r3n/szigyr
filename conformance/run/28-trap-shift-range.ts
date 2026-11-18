// expect-output: 2147483648
// expect-trap: T009 @ 7:12
// stage: 1
// open-question: Q002
// open-question: Q059
function shl(x: u32, n: u32): u32 {
  return x << n;
}

export function main(sys: System): void {
  sys.log.info(`${shl(1, 31)}`);
  const n: u32 = 32;
  sys.log.info(`${shl(1, n)}`);
}

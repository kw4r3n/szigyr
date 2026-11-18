// expect-output: 255
// expect-trap: T003 @ 9:10
// stage: 1
// open-question: Q002
// open-question: Q059
// open-question: Q027
// open-question: Q014
function toByte(x: f64): u8 {
  return u8(x);
}

export function main(sys: System): void {
  sys.log.info(`${toByte(255)}`);
  const x: f64 = 256;
  sys.log.info(`${toByte(x)}`);
}

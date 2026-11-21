// expect-output: 0 4294967295 4294967295
// expect-output: 252645135 252645120 252645135
// expect-output: 2147483648 4042322160 1
// expect-output: 2147483648 4294967295
// expect-output: -4 268435456 14 241 -12
// stage: 1
// open-question: Q014
// open-question: Q027
// open-question: Q059
export function main(sys: System): void {
  const a: u32 = 0xF0F0F0F0;
  const b: u32 = 0x0F0F0F0F;
  sys.log.info(`${a & b} ${a | b} ${a ^ b}`);
  sys.log.info(`${~a} ${a << 4} ${a >>> 4}`);
  const top: u32 = 0x80000000;
  sys.log.info(`${a & top} ${a | top} ${a >>> 31}`);
  const one: u32 = 1;
  sys.log.info(`${one << 31} ${~(one - 1)}`);
  const d: i32 = -15;
  sys.log.info(`${d >> 2} ${d << 28} ${~d} ${d & 255} ${d ^ 5}`);
}

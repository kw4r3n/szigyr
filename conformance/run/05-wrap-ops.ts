// expect-output: 4 16 196
// expect-output: -128 127
// expect-output: -2147483648 1
// expect-output: 1705032704 4294967295 1705032704
// expect-output: 32767
// expect-output: 1335831723
// stage: 1
// open-question: Q014
// open-question: Q027
// open-question: Q059
function fnv1a(data: Array<u8>): u32 {
  let h: u32 = 2166136261;
  for (const byte of data) {
    h = wrapMul(h ^ u32(byte), 16777619);
  }
  return h;
}
export function main(sys: System): void {
  const u: u8 = 250;
  const v: u8 = 10;
  sys.log.info(`${wrapAdd(u, v)} ${wrapSub(v, u)} ${wrapMul(u, v)}`);
  const hi8: i8 = 127;
  const one8: i8 = 1;
  sys.log.info(`${wrapAdd(hi8, one8)} ${wrapSub(wrapAdd(hi8, one8), one8)}`);
  const m: i32 = 2147483647;
  const one: i32 = 1;
  sys.log.info(`${wrapAdd(m, one)} ${wrapMul(m, m)}`);
  const big: u32 = 3000000000;
  const zero: u32 = 0;
  const one32: u32 = 1;
  sys.log.info(`${wrapMul(big, 2)} ${wrapSub(zero, one32)} ${wrapAdd(big, big)}`);
  const lo16: i16 = -32768;
  const one16: i16 = 1;
  sys.log.info(`${wrapSub(lo16, one16)}`);
  const data: Array<u8> = [104, 101, 108, 108, 111];
  sys.log.info(`${fnv1a(data)}`);
}

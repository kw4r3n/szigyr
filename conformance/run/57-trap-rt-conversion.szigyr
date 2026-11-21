// expect-output: 200
// expect-trap: T003 @ 7:10
// stage: 2
// open-question: Q002
function toByte(s: Ref<Slice<i32>>, i: usize): u8 {
  "use rt";
  return u8(s[i] * 2);
}

export function main(sys: System): void {
  const v = Vec.create<i32>(sys.alloc, 2);
  v.push(100);
  v.push(128);
  sys.log.info(`${toByte(v, 0)}`);
  sys.log.info(`${toByte(v, 1)}`);
}

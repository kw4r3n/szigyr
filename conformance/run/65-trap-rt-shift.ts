// expect-output: 4096
// expect-trap: T009 @ 7:17
// stage: 2
// open-question: Q002
function mask(bits: Ref<Slice<u32>>, i: usize): u32 {
  "use rt";
  return u32(1) << bits[i];
}

export function main(sys: System): void {
  const v = Vec.create<u32>(sys.alloc, 2);
  v.push(12);
  v.push(32);
  sys.log.info(`${mask(v, 0)}`);
  sys.log.info(`${mask(v, 1)}`);
}

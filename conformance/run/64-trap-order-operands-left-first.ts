// expect-output: start
// expect-trap: T001 @ 7:12
// stage: 2
// open-question: Q002
function combine(s: Ref<Slice<i32>>, k: i32): i32 {
  "use rt";
  return k * k + s[s.length];
}

export function main(sys: System): void {
  const v = Vec.create<i32>(sys.alloc, 1);
  v.push(0);
  sys.log.info("start");
  sys.log.info(`${combine(v, 65536)}`);
}

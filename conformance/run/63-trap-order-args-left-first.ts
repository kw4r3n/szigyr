// expect-output: start
// expect-trap: T002 @ 12:17
// stage: 2
// open-question: Q002
function pick(a: i32, b: i32): i32 {
  "use rt";
  return a;
}

function run(s: Ref<Slice<i32>>, z: i32): i32 {
  "use rt";
  return pick(s[s.length], divTrunc(1, z));
}

export function main(sys: System): void {
  const v = Vec.create<i32>(sys.alloc, 1);
  v.push(0);
  sys.log.info("start");
  sys.log.info(`${run(v, 0)}`);
}

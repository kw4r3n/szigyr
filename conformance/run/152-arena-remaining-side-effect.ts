// expect-output: rem=64 cnt=1
// stage: 2
function pick(cnt: Mut<Vec<i32>>): boolean {
  "use rt";
  cnt[0] += 1;
  return true;
}
function checkRem(a1: Ref<Arena>, a2: Ref<Arena>, cnt: Mut<Vec<i32>>): usize {
  "use rt";
  return (pick(cnt) ? a1 : a2).remaining;
}
export function main(sys: System): void {
  const a1 = Arena.create(sys.alloc, 64);
  const a2 = Arena.create(sys.alloc, 32);
  const cnt = Vec.create<i32>(sys.alloc, 1);
  cnt.push(0);
  const r = checkRem(a1, a2, cnt);
  sys.log.info(`rem=${r} cnt=${cnt[0]}`);
}

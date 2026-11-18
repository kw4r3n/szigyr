// expect-output: sum=6
// expect-trap: T002 @ 16:16
// stage: 2
// open-question: Q002
function sum(s: Ref<Slice<i32>>): i32 {
  "use rt";
  let acc: i32 = 0;
  for (let i: usize = 0; i < s.length; i += 1) {
    acc += s[i];
  }
  return acc;
}

function tail(s: Ref<Slice<i32>>, from: usize): i32 {
  "use rt";
  return sum(s.slice(from, s.length + 1));
}

export function main(sys: System): void {
  const v = Vec.create<i32>(sys.alloc, 3);
  v.push(1);
  v.push(2);
  v.push(3);
  sys.log.info(`sum=${sum(v)}`);
  sys.log.info(`${tail(v, 1)}`);
}

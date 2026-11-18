// expect-output: 6
// expect-trap: T010 @ 9:5
// stage: 2
// open-question: Q002
function sumAscending(s: Ref<Slice<i32>>): i32 {
  "use rt";
  let acc: i32 = 0;
  for (let i: usize = 0; i < s.length; i += 1) {
    invariant(i === 0 || s[i - 1] <= s[i]);
    acc += s[i];
  }
  return acc;
}

export function main(sys: System): void {
  const v = Vec.create<i32>(sys.alloc, 3);
  v.push(1);
  v.push(2);
  v.push(3);
  sys.log.info(`${sumAscending(v)}`);
  v[1] = 5;
  sys.log.info(`${sumAscending(v)}`);
}

// expect-output: 1000 -5 found=7 last=3
// stage: 2
const LIMIT: i32 = 1_000;
const LOW: i32 = -5;

function lastOdd(v: Mut<Vec<i32>>): i32 {
  "use owned";
  let found: i32 | null = null;
  let x = v.pop();
  while (x !== null) {
    if (rem(x, 2) !== 0 && found === null) {
      found = x;
    }
    x = v.pop();
  }
  return found === null ? LOW : found;
}

function limits(): i32 {
  "use rt";
  return LIMIT;
}

export function main(sys: System): void {
  const v = Vec.create<i32>(sys.alloc, 2);
  v.push(3);
  v.push(4);
  v.push(7);
  v.push(8);
  const e = Vec.create<i32>(sys.alloc, 1);
  sys.log.info(`${limits()} ${lastOdd(e)} found=${lastOdd(v)} last=3`);
}

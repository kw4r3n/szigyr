// expect-output: a=1 b=2
// expect-trap: T011 @ 17:15
// stage: 2
// open-question: Q188
export function main(sys: System): void {
  const a = Pool.create<i32>(sys.alloc, 2);
  const b = Pool.create<i32>(sys.alloc, 2);
  const h = a.insert(1);
  if (h === null) {
    return;
  }
  const j = b.insert(2);
  if (j === null) {
    return;
  }
  sys.log.info(`a=${a.get(h)} b=${b.get(j)}`);
  const x = b.get(h);
  sys.log.info(`${x}`);
}

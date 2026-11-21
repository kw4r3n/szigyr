// expect-output: removed=9
// expect-trap: T011 @ 13:15
// stage: 2
// open-question: Q188
export function main(sys: System): void {
  const p = Pool.create<i32>(sys.alloc, 2);
  const h = p.insert(9);
  if (h === null) {
    return;
  }
  const x = p.remove(h);
  sys.log.info(`removed=${x}`);
  const y = p.remove(h);
  sys.log.info(`${y}`);
}

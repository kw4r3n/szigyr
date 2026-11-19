// expect-output: inserted
// expect-output: removed=7
// expect-trap: T011 @ 15:15
// stage: 2
// open-question: Q188
export function main(sys: System): void {
  const p = Pool.create<i32>(sys.alloc, 2);
  const h = p.insert(7);
  if (h === null) {
    return;
  }
  sys.log.info("inserted");
  const x = p.remove(h);
  sys.log.info(`removed=${x}`);
  const y = p.get(h);
  sys.log.info(`${y}`);
}

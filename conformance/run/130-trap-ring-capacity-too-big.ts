// expect-trap: T014 @ 5:18
// stage: 3
// open-question: Q199
export function main(sys: System): void {
  const p = Ring.create<i32>(sys.alloc, 4294967295);
  const { tx } = p;
  tx.push(1);
  sys.log.info("unreachable");
}

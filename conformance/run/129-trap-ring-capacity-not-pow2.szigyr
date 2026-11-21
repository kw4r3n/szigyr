// expect-trap: T014 @ 6:15
// stage: 3
// open-question: Q199
function make(alloc: Alloc): RingPair<i32> {
  "use owned";
  return Ring.create<i32>(alloc, 3);
}
export function main(sys: System): void {
  const p = make(sys.alloc);
  const { tx } = p;
  tx.push(1);
  sys.log.info("unreachable");
}

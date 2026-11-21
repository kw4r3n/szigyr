// expect-output: filled
// expect-trap: T011 @ 14:5
// stage: 2
// open-question: Q188
export function main(sys: System): void {
  const p = Pool.create<i32>(sys.alloc, 1);
  const h = p.insert(1);
  if (h === null) {
    return;
  }
  const x = p.remove(h);
  const j = p.insert(2);
  sys.log.info("filled");
  p.set(h, 3);
  sys.log.info("unreached");
}

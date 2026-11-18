// expect-output: 7
// expect-trap: T008 @ 13:23
// stage: 2
// open-question: Q002
// open-question: Q047
// open-question: Q059
export function main(sys: System): void {
  const v = Vec.create<i32>(sys.alloc, 2);
  v.push(7);
  const cell: OwnedCell<Vec<i32>> = OwnedCell.create<Vec<i32>>(v);
  const first = cell.take();
  sys.log.info(`${first[0]}`);
  const second = cell.take();
  sys.log.info(`${second[0]}`);
}

// expect-output: empty=false
// expect-output: empty=true
// expect-output: total=10
// expect-output: empty=false
// expect-output: holder=10 again=10
// stage: 2
// open-question: Q027
// open-question: Q047
// open-question: Q059
function make(alloc: Alloc): Vec<i32> {
  "use owned";
  const v = Vec.create<i32>(alloc, 4);
  v.push(1);
  v.push(2);
  v.push(3);
  return v;
}

function total(v: Ref<Vec<i32>>): i32 {
  "use owned";
  let acc: i32 = 0;
  for (let i: usize = 0; i < v.length; i += 1) {
    acc += v[i];
  }
  return acc;
}

class Holder {
  readonly cell: OwnedCell<Vec<i32>>;

  constructor(cell: OwnedCell<Vec<i32>>) {
    this.cell = cell;
  }

  sum(): i32 {
    const v = this.cell.take();
    const t = total(v);
    this.cell.put(v);
    return t;
  }
}

export function main(sys: System): void {
  const cell: OwnedCell<Vec<i32>> = OwnedCell.create<Vec<i32>>(make(sys.alloc));
  sys.log.info(`empty=${cell.isEmpty()}`);
  const v = cell.take();
  sys.log.info(`empty=${cell.isEmpty()}`);
  v.push(4);
  sys.log.info(`total=${total(v)}`);
  cell.put(v);
  sys.log.info(`empty=${cell.isEmpty()}`);
  const h = new Holder(cell);
  sys.log.info(`holder=${h.sum()} again=${h.sum()}`);
}

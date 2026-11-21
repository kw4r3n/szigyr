// expect: ok
// stage: 2
// open-question: Q047
// open-question: Q029
export class Holder {
  private readonly cell: OwnedCell<Vec<f32>>;

  constructor(alloc: Alloc) {
    this.cell = OwnedCell.create<Vec<f32>>(Vec.create<f32>(alloc, 4));
  }

  take(): Vec<f32> {
    return this.cell.take();
  }

  put(v: Vec<f32>): void {
    this.cell.put(v);
  }

  has(): boolean {
    return !this.cell.isEmpty();
  }
}

test("owned cell", (t: Test) => {
  const alloc = TestAlloc.create();
  const h = new Holder(alloc);
  t.ok(h.has());
  const v = h.take();
  t.ok(!h.has());
  h.put(v);
  t.ok(h.has());
  t.traps("T008", () => {
    const q = new Holder(TestAlloc.create());
    const a = q.take();
    const b = q.take();
  });
});

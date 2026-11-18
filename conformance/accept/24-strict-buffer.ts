// expect: ok
// stage: 2
// A-3: strict。所有権の移動と Struct
type Buffer = Struct<{ data: Vec<f32>; readonly rate: u32 }>;

export function makeBuffer(alloc: Alloc, n: usize, rate: u32): Buffer {
  "use owned";
  const data = Vec.create<f32>(alloc, n);
  const b: Buffer = { data, rate };   // data はここで移動する
  return b;
}

test("makeBuffer", (t: Test) => {
  const b = makeBuffer(TestAlloc.create(), 4, 44100);
  t.eq(b.rate, 44100);
});

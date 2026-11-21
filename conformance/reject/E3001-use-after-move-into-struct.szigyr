// expect: E3001 @ 8:10
// stage: 2
type Buf = Struct<{ data: Vec<f32>; readonly rate: u32 }>;
function f(alloc: Alloc): usize {
  "use owned";
  const data = Vec.create<f32>(alloc, 4);
  const b: Buf = { data, rate: 1 };
  return data.length;
}

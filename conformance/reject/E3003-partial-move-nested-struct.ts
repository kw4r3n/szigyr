// expect: E3003 @ 7:13
// stage: 2
type Buf = Struct<{ data: Vec<f32>; readonly rate: u32 }>;
type Outer = Struct<{ inner: Buf; readonly k: u32 }>;
function f(o: Outer): u32 {
  "use owned";
  const v = o.inner;
  return v.rate;
}

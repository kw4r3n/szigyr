// expect: E3003 @ 6:13
// stage: 2
type Buf = Struct<{ data: Vec<f32>; readonly rate: u32 }>;
function f(s: Buf): usize {
  "use owned";
  const v = s.data;
  return v.length;
}

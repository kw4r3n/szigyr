// expect: E3003 @ 6:26
// stage: 2
type Buf = Struct<{ data: Vec<f32>; readonly rate: u32 }>;
function f(s: Buf): Buf {
  "use owned";
  const t: Buf = { data: s.data, rate: 1 };
  return t;
}

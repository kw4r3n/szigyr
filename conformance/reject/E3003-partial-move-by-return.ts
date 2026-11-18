// expect: E3003 @ 7:10
// stage: 2
// open-question: Q002
type Buf = Struct<{ data: Vec<f32>; readonly rate: u32 }>;
function f(s: Buf): Vec<f32> {
  "use owned";
  return s.data;
}

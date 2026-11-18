// expect: E3004 @ 7:26
// stage: 2
// open-question: Q002
type Buf = Struct<{ data: Vec<f32>; readonly rate: u32 }>;
function f(v: Mut<Vec<f32>>): Buf {
  "use owned";
  const b: Buf = { data: v, rate: 1 };
  return b;
}

// expect: E4004 @ 7:10
// stage: 2
// open-question: Q002
type Buf = Struct<{ data: Vec<f32>; readonly rate: u32 }>;
function p(s: Mut<Buf>): void {
  "use rt";
  s.data.push(1);
}

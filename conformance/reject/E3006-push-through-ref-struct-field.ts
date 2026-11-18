// expect: E3006 @ 7:10
// stage: 2
// open-question: Q050
type Buf = Struct<{ data: Vec<f32>; readonly rate: u32 }>;
function g(b: Ref<Buf>): void {
  "use owned";
  b.data.push(1);
}

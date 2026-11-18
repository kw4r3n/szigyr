// expect: E3003 @ 9:11
// stage: 2
type Buf = Struct<{ data: Vec<f32>; readonly rate: u32 }>;
function consume(v: Vec<f32>): void {
  "use owned";
}
function f(s: Buf): void {
  "use owned";
  consume(s.data);
}

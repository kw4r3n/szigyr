// expect: E2002 @ 5:19
// stage: 1
// open-question: Q086
type Buf = Struct<{ data: Vec<f32> }>;
function f(v: Vec<Buf>): void {}

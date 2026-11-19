// expect: E4002 @ 6:20
// stage: 2
// open-question: Q086
// open-question: Q188
type Buf = Struct<{ data: Vec<f32> }>;
function f(p: Pool<Buf>): void {}

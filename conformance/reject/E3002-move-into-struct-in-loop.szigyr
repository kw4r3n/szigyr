// expect: E3002 @ 10:28
// stage: 2
// open-question: Q002
type Buf = Struct<{ data: Vec<f32>; readonly rate: u32 }>;
function f(alloc: Alloc, n: usize): void {
  "use owned";
  const a = Vec.create<f32>(alloc, 4);
  let i: usize = 0;
  do {
    const s: Buf = { data: a, rate: 1 };
    i += 1;
  } while (i < n);
}

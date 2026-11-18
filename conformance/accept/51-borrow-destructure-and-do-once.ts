// expect: ok
// stage: 2
type Buf = Struct<{ data: Vec<f32>; readonly rate: u32 }>;
function eat(v: Vec<f32>): usize {
  "use owned";
  return v.length;
}
function norm(p: Ref<Buf>): u32 {
  "use owned";
  const { rate } = p;
  return rate;
}
function once(alloc: Alloc): usize {
  "use owned";
  const a = Vec.create<f32>(alloc, 1);
  let n: usize = 0;
  do {
    n = eat(a);
  } while (false);
  return n;
}

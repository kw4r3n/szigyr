// expect: ok
// stage: 2
// open-question: Q052
type Buf = Struct<{ data: Vec<f32>; readonly rate: u32 }>;

export function make(alloc: Alloc, rate: u32): Buf {
  "use owned";
  const data = Vec.create<f32>(alloc, 8);
  return { data, rate };
}

function sumF(v: Ref<Vec<f32>>): f32 {
  "use owned";
  let s: f32 = 0;
  for (let i: usize = 0; i < v.length; i += 1) {
    s += v[i];
  }
  return s;
}

// Ref で受け取った Struct のフィールドパスを、そのまま借用で渡せる
export function sumBuf(b: Ref<Buf>): f32 {
  "use owned";
  return sumF(b.data);
}

export function rateOf(b: Ref<Buf>): u32 {
  "use owned";
  return b.rate;
}

export function append(b: Mut<Buf>, x: f32): void {
  "use owned";
  b.data.push(x);
}

// 分解すると Struct 全体が移動する
export function finish(b: Buf): u32 {
  "use owned";
  const { data, rate } = b;
  return rate + u32(data.length);
}

test("struct borrow fields", (t: Test) => {
  const b = make(TestAlloc.create(), 48000);
  append(b, 1.5);
  append(b, 2);
  t.eq(sumBuf(b), 3.5);
  t.eq(rateOf(b), 48000);
  t.eq(finish(b), 48002);
});

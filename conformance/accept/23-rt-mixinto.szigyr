// expect: ok
// stage: 2
// open-question: Q014
// open-question: Q047
// A-2: rt。借用と契約
export function mixInto(out: Mut<Slice<f32>>, src: Ref<Slice<f32>>, gain: f32): void {
  "use rt";
  requires(out.length === src.length);
  for (let i: usize = 0; i < out.length; i += 1) {
    out[i] = out[i] + src[i] * gain;
  }
}

test("mixInto adds scaled source", (t: Test) => {
  const alloc = TestAlloc.create();
  const a = Vec.create<f32>(alloc, 2);
  a.push(1); a.push(2);
  const b = Vec.create<f32>(alloc, 2);
  b.push(10); b.push(20);
  mixInto(a, b, 0.5);
  t.eq(a[0], 6);
  t.eq(a[1], 12);
});

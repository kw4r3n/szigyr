// expect: ok
// stage: 2
// open-question: Q189
function sq(x: f32): f32 {
  "use rt";
  return x * x;
}
function mapInto(dst: Mut<Slice<f32>>, src: Ref<Slice<f32>>, f: (x: f32) => f32): void {
  "use rt";
  for (let i: usize = 0; i < dst.length; i += 1) {
    dst[i] = f(src[i]);
  }
}
function applyMap(dst: Mut<Slice<f32>>, src: Ref<Slice<f32>>): void {
  "use rt";
  mapInto(dst, src, sq);
}

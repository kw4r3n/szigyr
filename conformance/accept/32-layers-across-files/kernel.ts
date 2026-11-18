"use rt";

export function dot(a: Ref<Slice<f32>>, b: Ref<Slice<f32>>): f32 {
  requires(a.length === b.length);
  let s: f32 = 0;
  for (let i: usize = 0; i < a.length; i += 1) {
    s += a[i] * b[i];
  }
  return s;
}

export function gain(out: Mut<Slice<f32>>, k: f32): void {
  for (let i: usize = 0; i < out.length; i += 1) {
    out[i] = out[i] * k;
  }
}

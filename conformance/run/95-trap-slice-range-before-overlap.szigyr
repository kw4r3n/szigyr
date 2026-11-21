// expect-trap: T002 @ 14:29
// stage: 2
// open-question: Q190
function copyInto(dst: Mut<Slice<f32>>, src: Ref<Slice<f32>>): void {
  "use rt";
  for (let i: usize = 0; i < dst.length; i += 1) {
    dst[i] = src[i];
  }
}

export function main(sys: System): void {
  const v = Vec.create<f32>(sys.alloc, 4);
  v.push(0); v.push(1); v.push(2); v.push(3);
  copyInto(v.slice(0, 3), v.slice(2, 99));
  sys.log.info("unreached");
}

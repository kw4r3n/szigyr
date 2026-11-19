// expect-output: made
// expect-trap: T013 @ 19:25
// stage: 2
// open-question: Q188
function copyInto(dst: Mut<Slice<f32>>, src: Ref<Slice<f32>>): void {
  "use rt";
  for (let i: usize = 0; i < dst.length; i += 1) {
    dst[i] = src[i];
  }
}

export function main(sys: System): void {
  const a = Arena.create(sys.alloc, 64);
  const b = a.alloc<f32>(4, 1);
  if (b === null) {
    return;
  }
  sys.log.info("made");
  copyInto(a.view(b), a.view(b));
  sys.log.info("unreached");
}

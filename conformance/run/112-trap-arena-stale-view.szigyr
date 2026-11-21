// expect-output: made
// expect-trap: T012 @ 22:20
// stage: 2
// open-question: Q188
function sumF(s: Ref<Slice<f32>>): f32 {
  "use rt";
  let acc: f32 = 0;
  for (let i: usize = 0; i < s.length; i += 1) {
    acc += s[i];
  }
  return acc;
}

export function main(sys: System): void {
  const a = Arena.create(sys.alloc, 64);
  const b = a.alloc<f32>(4, 1);
  if (b === null) {
    return;
  }
  sys.log.info("made");
  a.reset();
  const x = sumF(a.view(b));
  sys.log.info(`unreached ${x}`);
}

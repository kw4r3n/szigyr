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
  const other = Arena.create(sys.alloc, 64);
  const ob = other.alloc<f32>(2, 3);
  if (ob === null) {
    return;
  }
  sys.log.info("made");
  const x = sumF(a.view(ob));
  sys.log.info(`unreached ${x}`);
}

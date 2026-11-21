// expect-output: dst=5,6 sum=22
// stage: 2
// open-question: Q188
function copyInto(dst: Mut<Slice<f32>>, src: Ref<Slice<f32>>): void {
  "use rt";
  for (let i: usize = 0; i < dst.length; i += 1) {
    dst[i] = src[i];
  }
}

function fillSeq(s: Mut<Slice<f32>>): void {
  "use rt";
  let v: f32 = 5;
  for (let i: usize = 0; i < s.length; i += 1) {
    s[i] = v;
    v += 1;
  }
}

function sumF(s: Ref<Slice<f32>>): f32 {
  "use rt";
  let acc: f32 = 0;
  for (let i: usize = 0; i < s.length; i += 1) {
    acc += s[i];
  }
  return acc;
}

function at(s: Ref<Slice<f32>>, i: usize): f32 {
  "use rt";
  return s[i];
}

export function main(sys: System): void {
  const a = Arena.create(sys.alloc, 64);
  const dst = a.alloc<f32>(2, 0);
  const src = a.alloc<f32>(2, 0);
  if (dst === null || src === null) {
    return;
  }
  fillSeq(a.view(src));
  copyInto(a.view(dst), a.view(src));
  sys.log.info(`dst=${at(a.view(dst), 0)},${at(a.view(dst), 1)} sum=${sumF(a.view(dst)) + sumF(a.view(src))}`);
}

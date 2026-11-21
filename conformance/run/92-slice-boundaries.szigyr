// expect-output: lens=4 4 0
// expect-output: sum=9
// expect-output: after=2 3 2 3
// stage: 2
// open-question: Q190
function copyInto(dst: Mut<Slice<f32>>, src: Ref<Slice<f32>>): void {
  "use rt";
  for (let i: usize = 0; i < dst.length; i += 1) {
    dst[i] = src[i];
  }
}

function probe(a: Mut<Slice<f32>>, b: Ref<Slice<f32>>): usize {
  "use rt";
  return a.length + b.length;
}

function sumPair(a: Ref<Slice<f32>>, b: Ref<Slice<f32>>): f32 {
  "use rt";
  let acc: f32 = 0;
  for (let i: usize = 0; i < a.length; i += 1) {
    acc += a[i];
  }
  for (let i: usize = 0; i < b.length; i += 1) {
    acc += b[i];
  }
  return acc;
}

export function main(sys: System): void {
  const v = Vec.create<f32>(sys.alloc, 4);
  v.push(0); v.push(1); v.push(2); v.push(3);
  sys.log.info(`lens=${probe(v.slice(0, 4), v.slice(2, 2))} ${probe(v.slice(2, 2), v.slice(0, 4))} ${probe(v.slice(2, 2), v.slice(2, 2))}`);
  sys.log.info(`sum=${sumPair(v.slice(0, 3), v.slice(1, 4))}`);
  copyInto(v.slice(0, 2), v.slice(2, 4));
  sys.log.info(`after=${v[0]} ${v[1]} ${v[2]} ${v[3]}`);
}

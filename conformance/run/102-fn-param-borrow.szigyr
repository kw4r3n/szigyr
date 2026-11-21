// expect-output: 25
// stage: 2
function sumSq(s: Ref<Slice<f32>>): f32 {
  "use rt";
  let acc: f32 = 0;
  for (let i: usize = 0; i < s.length; i += 1) {
    acc += s[i] * s[i];
  }
  return acc;
}
function foldSlice(s: Ref<Slice<f32>>, f: (x: Ref<Slice<f32>>) => f32): f32 {
  "use rt";
  return f(s);
}
export function main(sys: System): void {
  const a = Vec.create<f32>(sys.alloc, 2);
  a.push(3); a.push(4);
  sys.log.info(`${foldSlice(a, sumSq)}`);
}

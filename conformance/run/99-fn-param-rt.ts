// expect-output: 1 4 9
// expect-output: -1 -2 -3
// stage: 2
function sq(x: f32): f32 {
  "use rt";
  return x * x;
}
function neg(x: f32): f32 {
  "use rt";
  return 0 - x;
}
function mapInto(dst: Mut<Slice<f32>>, src: Ref<Slice<f32>>, f: (x: f32) => f32): void {
  "use rt";
  for (let i: usize = 0; i < dst.length; i += 1) {
    dst[i] = f(src[i]);
  }
}
function mapSq(dst: Mut<Slice<f32>>, src: Ref<Slice<f32>>): void {
  "use rt";
  mapInto(dst, src, sq);
}
export function main(sys: System): void {
  const a = Vec.create<f32>(sys.alloc, 3);
  a.push(1); a.push(2); a.push(3);
  const b = Vec.create<f32>(sys.alloc, 3);
  b.push(0); b.push(0); b.push(0);
  mapSq(b, a);
  sys.log.info(`${b[0]} ${b[1]} ${b[2]}`);
  mapInto(b, a, neg);
  sys.log.info(`${b[0]} ${b[1]} ${b[2]}`);
}

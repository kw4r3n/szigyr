// expect-output: first=1.5
// expect-output: second=7
// expect-output: third=9
// stage: 2
function wr(v: Mut<Slice<f32>>, x: f32): void {
  "use rt";
  v[0] = x;
}
function setc(a: Mut<Arena>, b: ArenaBuf<f32>, x: f32): void {
  "use rt";
  wr(a.view(b), x);
}
function head<T>(s: Ref<Slice<T>>): T {
  return s[0];
}
function headG<T>(a: Ref<Arena>, b: ArenaBuf<T>): T {
  return head(a.view(b));
}
export function main(sys: System): void {
  const a = Arena.create(sys.alloc, 64);
  const b = a.alloc<f32>(2, 1.5);
  if (b === null) {
    return;
  }
  sys.log.info(`first=${headG(a, b)}`);
  setc(a, b, 7);
  sys.log.info(`second=${headG(a, b)}`);
  setc(a, b, 9);
  sys.log.info(`third=${headG(a, b)}`);
}

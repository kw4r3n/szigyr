// expect-output: head=1.5 second=7
// stage: 2
function mk(a: Mut<Arena>, n: usize, x: f32): ArenaBuf<f32> | null {
  "use rt";
  return a.alloc<f32>(n, x);
}
function mk2(a: Mut<Arena>): ArenaBuf<i32> | null {
  "use rt";
  return a.alloc<i32>(3, 7);
}
function head<T>(s: Ref<Slice<T>>): T {
  return s[0];
}
function headG<T>(a: Ref<Arena>, b: ArenaBuf<T>): T {
  return head(a.view(b));
}
export function main(sys: System): void {
  const a = Arena.create(sys.alloc, 64);
  const b = mk(a, 2, 1.5);
  const c = mk2(a);
  if (b === null || c === null) { return; }
  sys.log.info(`head=${headG(a, b)} second=${headG(a, c)}`);
}

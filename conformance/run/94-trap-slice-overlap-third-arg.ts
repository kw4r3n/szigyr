// expect-trap: T013 @ 11:38
// stage: 2
// open-question: Q190
function f3(a: Mut<Slice<f32>>, b: Ref<Slice<f32>>, c: Ref<Slice<f32>>): void {
  "use rt";
}

export function main(sys: System): void {
  const v = Vec.create<f32>(sys.alloc, 4);
  v.push(0); v.push(1); v.push(2); v.push(3);
  f3(v.slice(0, 2), v.slice(2, 4), v.slice(1, 3));
  sys.log.info("unreached");
}

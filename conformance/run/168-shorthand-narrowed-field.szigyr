// expect-output: 5 6 -1
// stage: 2
type W = Struct<{ h: Handle<f32>; n: i32 }>;
function f(p: Mut<Pool<f32>>, n: i32): i32 {
  "use rt";
  const h = p.insert(1);
  if (h !== null) {
    const w: W = { h, n };
    return p.has(w.h) ? w.n : 0;
  }
  return -1;
}
export function main(sys: System): void {
  const p = Pool.create<f32>(sys.alloc, 2);
  const a = f(p, 5);
  const b = f(p, 6);
  sys.log.info(`${a} ${b} ${f(p, 7)}`);
}

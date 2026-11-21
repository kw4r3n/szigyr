// expect-output: 6 5 3 10 6 16 6
// expect-output: strict 18
// stage: 2
type R = { x: f32 };
type S = Struct<{ x: f32 }>;

function strictF32(alloc: Alloc, c: boolean): f32 {
  "use owned";
  let x: f32 = 2;
  x *= c ? 10 : 3;
  const s: S = { x: 2 };
  s.x *= c ? 10 : 3;
  const v = Vec.create<f32>(alloc, 1);
  v.push(2);
  v[0] *= c ? 10 : 3;
  return x + s.x + v[0];
}

export function main(sys: System): void {
  const c: boolean = false;
  let x: f32 = 2;
  x *= c ? 10 : 3;
  let x2: f32 = 8;
  let y2: f32 = 1;
  x2 -= y2 = 3;
  let x3: f32 = 2;
  const n: f32 | null = null;
  x3 *= n ?? 5;
  const p: R = { x: 2 };
  p.x *= c ? 10 : 3;
  const f: Array<f32> = [8];
  f[0] *= true ? 2 : 3;
  const d: Array<f64> = [2];
  d[0] *= c ? 10 : 3;
  sys.log.info(`${x} ${x2} ${y2} ${x3} ${p.x} ${f[0]} ${d[0]}`);
  sys.log.info(`strict ${strictF32(sys.alloc, false)}`);
}

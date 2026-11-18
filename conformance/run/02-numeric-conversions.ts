// expect-output: 42 242 242 60.5
// expect-output: 16777216 16777217
// expect-output: 0.10000000149011612 false
// expect-output: -3 242 7
// stage: 1
// open-question: Q014
// open-question: Q027
// open-question: Q034
// open-question: Q059
export function main(sys: System): void {
  const a: f64 = 42;
  const i: i32 = i32(a);
  const u: u8 = u8(i + 200);
  const n: usize = usize(u);
  const back: f64 = f64(n) / 4;
  sys.log.info(`${i} ${u} ${n} ${back}`);
  const big: f64 = 16777217;
  const s: f32 = f32(big);
  sys.log.info(`${s} ${f64(s) + 1}`);
  const t: f32 = f32(0.1);
  sys.log.info(`${t} ${f64(t) === 0.1}`);
  const neg: f64 = -3;
  sys.log.info(`${i32(neg)} ${i32(u)} ${u32(i32(neg) + 10)}`);
}

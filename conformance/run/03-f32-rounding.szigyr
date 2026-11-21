// expect-output: 0.10000000149011612
// expect-output: 0.30000001192092896
// expect-output: 0.6000000238418579
// expect-output: 16777216
// expect-output: 0.010000000707805157
// expect-output: 0.30000001192092896
// expect-output: 0.30000000447034836
// expect-output: 1.0000001192092896
// expect-output: 0.03333333507180214
// stage: 1
// open-question: Q014
// open-question: Q015
// open-question: Q027
// open-question: Q059
function sum3(a: f32, b: f32, c: f32): f32 {
  return a + b + c;
}
export function main(sys: System): void {
  const a: f32 = 0.1;
  const b: f32 = 0.2;
  sys.log.info(`${a}`);
  sys.log.info(`${a + b}`);
  sys.log.info(`${sum3(0.1, 0.2, 0.3)}`);
  const big: f32 = 16777216;
  sys.log.info(`${big + 1}`);
  const m: f32 = a * a;
  sys.log.info(`${m}`);
  sys.log.info(`${Math.fround(0.3)}`);
  sys.log.info(`${f64(a) + f64(b)}`);
  let acc: f32 = 0;
  for (let i: i32 = 0; i < 10; i += 1) {
    acc += 0.1;
  }
  sys.log.info(`${acc}`);
  sys.log.info(`${a / 3}`);
}

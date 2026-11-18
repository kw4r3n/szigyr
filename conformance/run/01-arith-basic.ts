// expect-output: 22 12 85
// expect-output: 3.5 1 49 -7
// expect-output: 0.30000000000000004
// expect-output: 385
// expect-output: 1e+21 333333333333333300000
// expect-output: Infinity -Infinity NaN
// stage: 1
// open-question: Q014
// open-question: Q027
// open-question: Q059
export function main(sys: System): void {
  const a: i32 = 17;
  const b: i32 = 5;
  sys.log.info(`${a + b} ${a - b} ${a * b}`);
  const x: f64 = 7;
  const y: f64 = 2;
  sys.log.info(`${x / y} ${x % y} ${x ** y} ${-x}`);
  const z: f64 = 0.1;
  sys.log.info(`${z + 0.2}`);
  let acc: i32 = 0;
  for (let i: i32 = 1; i <= 10; i += 1) {
    acc += i * i;
  }
  sys.log.info(`${acc}`);
  const big: f64 = 1e21;
  sys.log.info(`${big} ${big / 3}`);
  const zero: f64 = y - 2;
  sys.log.info(`${x / zero} ${-x / zero} ${zero / zero}`);
}

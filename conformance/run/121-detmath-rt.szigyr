// expect-output: 13.244678857587584
// expect-output: 1.6375611604557176
// stage: 2
function oscSum(): f64 {
  "use rt";
  let s: f64 = 0;
  for (let i: usize = 0; i < 100; i += 1) {
    const fi = f64(i);
    s += DetMath.sin(fi * 0.1) * DetMath.exp(0 - fi * 0.01);
  }
  return s;
}
function envSum(): f64 {
  "use owned";
  let s: f64 = 0;
  for (let i: usize = 0; i < 50; i += 1) {
    const fi = f64(i);
    s += DetMath.tanh(fi * 0.05 - 1) * DetMath.cos(fi * 0.3);
  }
  return s;
}
export function main(sys: System): void {
  sys.log.info(`${oscSum()}`);
  sys.log.info(`${envSum()}`);
}

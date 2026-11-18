// expect-output: 1 2 2 0 0 3 3
// expect-output: 1 0
// stage: 2
function pick(x: f64): i32 {
  "use rt";
  let r: i32 = 0;
  switch (x) {
    case 1.5: r = 1; break;
    case 0: r = 2; break;
    default: r = 0; break;
    case -2.25:
    case 1e300: r = 3;
  }
  return r;
}
function pick32(x: f32): i32 {
  "use rt";
  switch (x) {
    case 0.1: return 1;
    default: return 0;
  }
}
export function main(sys: System): void {
  const nan = 0 / 0;
  sys.log.info(`${pick(1.5)} ${pick(0)} ${pick(-0)} ${pick(nan)} ${pick(2)} ${pick(-2.25)} ${pick(1e300)}`);
  sys.log.info(`${pick32(0.1)} ${pick32(0.2)}`);
}

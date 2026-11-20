// expect-output: 0
// expect-output: 5
// expect-output: 2.5
// stage: 1
// open-question: Q237
function pick(n: i32 | null): i32 {
  const x = n === null ? 0 : n;
  return x;
}
function half(n: f64 | null): f64 {
  const x = n === null ? 0 : n;
  return x;
}
export function main(sys: System): void {
  sys.log.info(`${pick(null)}`);
  sys.log.info(`${pick(5)}`);
  sys.log.info(`${half(2.5)}`);
}

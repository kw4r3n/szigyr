// expect-output: 1073741824
// expect-trap: T001 @ 8:10
// stage: 2
// open-question: Q002
// open-question: Q090
function half(a: i32, b: i32): i32 {
  "use rt";
  return divTrunc(a, b);
}

export function main(sys: System): void {
  sys.log.info(`${half(-2147483648, -2)}`);
  sys.log.info(`${half(-2147483648, -1)}`);
}

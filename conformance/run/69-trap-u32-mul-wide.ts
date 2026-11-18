// expect-output: 4294836225
// expect-trap: T001 @ 7:12
// stage: 2
// open-question: Q002
function sq(a: u32): u32 {
  "use rt";
  return a * a;
}

export function main(sys: System): void {
  sys.log.info(`${sq(65535)}`);
  sys.log.info(`${sq(4294967295)}`);
}

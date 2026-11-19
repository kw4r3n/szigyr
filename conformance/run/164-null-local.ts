// expect-output: v=1 3
// stage: 2
function go(): i32 {
  "use rt";
  const n: null = null;
  if (n === null) { return 1; }
  return 2;
}
function go2(): i32 {
  "use rt";
  if (null === null) { return 3; }
  return 4;
}
export function main(sys: System): void {
  sys.log.info(`v=${go()} ${go2()}`);
}

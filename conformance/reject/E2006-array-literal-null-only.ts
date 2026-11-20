// expect: E2006 @ 6:13
// stage: 1
// open-question: Q235
export function main(sys: System): void {
  sys.log.info(`ok`);
  const w = [null, null];
}

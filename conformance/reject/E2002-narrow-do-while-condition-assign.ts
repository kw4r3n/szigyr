// expect: E2002 @ 7:21
// stage: 1
// open-question: Q133
export function main(sys: System): void {
  let x: string | null = null;
  do { break; } while ((x = "a") === "b");
  sys.log.info(`${x.length}`);
}

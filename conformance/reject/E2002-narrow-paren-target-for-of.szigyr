// expect: E2002 @ 7:43
// stage: 1
// open-question: Q133
export function main(sys: System): void {
  let x: string | null = null; x = "a";
  const xs: Array<i32> = [1, 2];
  for (const v of xs) { sys.log.info(`${x.length}`); (x) = null; }
}

// expect: E2002 @ 7:37
// stage: 1
// open-question: Q133
export function main(sys: System): void {
  let x: string | null = null; x = "a";
  let i: i32 = 0;
  while (i < 2) { sys.log.info(`${x.length}`); (x) = null; i += 1; }
}

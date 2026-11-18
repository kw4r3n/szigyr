// expect: E2002 @ 6:63
// stage: 1
// open-question: Q133
export function main(sys: System): void {
  let x: string | null = null; x = "a";
  for (let i: i32 = 0; i < 2; (x) = null) { sys.log.info(`${x.length}`); i += 1; }
}

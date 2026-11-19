// expect: E2002 @ 8:48
// stage: 1
// open-question: Q122
class P { readonly n: i32; constructor(n: i32) { this.n = n; } }
export function main(sys: System): void {
  let x: P | null = new P(1);
  const clear = (): void => { x = null; { const x: i32 = 2; sys.log.info(`${x}`); } };
  if (x !== null) { clear(); sys.log.info(`${x.n}`); }
}

// expect: E2002 @ 7:29
// stage: 1
// open-question: Q221
class P { readonly n: i32; constructor(n: i32) { this.n = n; } }
function mk(): P { return new P(1); }
export function main(sys: System): void {
  const f = (flag: boolean) => { if (flag) return mk(); };
  const r = f(false);
  sys.log.info(`${r.n}`);
}

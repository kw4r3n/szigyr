// expect: E2002 @ 11:21
// stage: 1
// open-question: Q121
class A {
  readonly f: string | null;
  readonly n: usize;
  constructor() {
    this.f = "a";
    if (this.f === null) { panic("no"); }
    this.f = null;
    this.n = this.f.length;
  }
}
export function main(sys: System): void { const a = new A(); sys.log.info(`${a.n}`); }

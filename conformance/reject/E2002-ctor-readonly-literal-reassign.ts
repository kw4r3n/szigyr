// expect: E2002 @ 12:20
// stage: 1
// open-question: Q121
type K = "a" | "b";
class A {
  readonly f: K;
  readonly n: string;
  constructor() {
    this.f = "a";
    if (this.f === "b") { panic("no"); }
    this.f = "b";
    const k: "a" = this.f;
    this.n = k;
  }
}
export function main(sys: System): void { sys.log.info(new A().n); }

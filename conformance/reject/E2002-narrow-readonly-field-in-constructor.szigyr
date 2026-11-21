// expect: E2002 @ 10:33
// stage: 1
// open-question: Q121
class A {
  readonly f: string | null;
  n: usize;
  constructor() {
    this.f = "a";
    this.n = 0;
    if (this.f !== null) { this.f = null; this.n = this.f.length; }
  }
}

// expect: E2002 @ 8:14
// stage: 1
// open-question: Q121
class A {
  s: string;
  n: usize;
  constructor() {
    this.n = this.len();
    this.s = "x";
  }
  len(): usize {
    return this.s.length;
  }
}

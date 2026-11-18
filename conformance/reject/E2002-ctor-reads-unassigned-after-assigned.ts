// expect: E2002 @ 9:30
// stage: 1
// open-question: Q121
class A {
  s: string;
  n: usize;
  constructor() {
    this.s = "abc";
    this.n = this.s.length + this.n;
  }
}

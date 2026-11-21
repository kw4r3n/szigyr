// expect: E2002 @ 7:15
// stage: 1
// open-question: Q121
class A {
  readonly s: string;
  constructor(sink: Array<A>) {
    sink.push(this);
    this.s = "x";
  }
}

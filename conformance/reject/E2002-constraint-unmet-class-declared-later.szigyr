// expect: E2002 @ 7:19
// stage: 1
// open-question: Q075
interface Scored {
  score(): f64;
}
function f(b: Box<i32>): void {}
class Box<T extends Scored> {
  readonly v: T;
  constructor(v: T) {
    this.v = v;
  }
}

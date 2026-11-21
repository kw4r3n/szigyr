// expect: E1000 @ 7:43
// stage: 1
// open-question: Q120
class A {
  v: string = "a";
  m(): usize {
    const g = function (): usize { return this.v.length; };
    return g();
  }
}

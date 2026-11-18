// expect: E1000 @ 10:9
// stage: 1
// open-question: Q004
class A {
  x: i32;
  constructor(x: i32) {
    this.x = x;
  }
}
class B extends A {
  y: i32 = 0;
}

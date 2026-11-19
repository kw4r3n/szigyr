// expect: E1000 @ 7:3
// stage: 1
// open-question: Q029
class K {
  readonly a: i32;
  constructor(a: i32) { this.a = a; }
  constructor(a: i32, b: i32) { this.a = b; }
}

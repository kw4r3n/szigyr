// expect: E2002 @ 7:20
// stage: 1
// open-question: Q132
interface C {
  id<T>(x: T): T;
}
class U implements C {
  id(x: i32): i32 {
    return x;
  }
}

// expect: ok
// stage: 1
interface C {
  id<T>(x: T): T;
}
class U implements C {
  id<T>(x: T): T {
    return x;
  }
}
function f(): i32 {
  const u: C = new U();
  return u.id<i32>(3);
}

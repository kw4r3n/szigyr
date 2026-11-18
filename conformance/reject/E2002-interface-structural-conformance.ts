// expect: E2002 @ 17:18
// stage: 1
// open-question: Q020
interface HasArea {
  area(): f64;
}
class Square {
  readonly side: f64 = 2;
  area(): f64 {
    return this.side * this.side;
  }
}
function measure(s: HasArea): f64 {
  return s.area();
}
function f(q: Square): f64 {
  return measure(q);
}

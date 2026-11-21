// expect: E3004 @ 7:12
// stage: 3
// D147: a borrowed boxed ring endpoint keeps the box's keep-alive ref in its descriptor; it must never reach JS by value.
export function f(p: Ptr<RingRx<i32>>): RingRx<i32> {
  "use owned";
  "use unsafe";
  return p.borrow();
}

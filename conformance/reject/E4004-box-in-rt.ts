// expect: E4004 @ 6:14
// stage: 3
export function f(x: i32): Ptr<i32> {
  "use rt";
  "use unsafe";
  return Ptr.box(TestAlloc.create(), x);
}

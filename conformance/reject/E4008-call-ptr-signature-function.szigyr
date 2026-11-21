// expect: E4008 @ 10:10
// stage: 3
function get(alloc: Alloc): Ptr<i32> {
  "use owned";
  "use unsafe";
  return Ptr.box(alloc, 7);
}
export function f(alloc: Alloc): i32 {
  "use owned";
  return get(alloc).read();
}

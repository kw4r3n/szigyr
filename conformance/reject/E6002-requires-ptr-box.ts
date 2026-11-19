// expect: E6002 @ 6:17
// stage: 3
export function f(alloc: Alloc): i32 {
  "use owned";
  "use unsafe";
  requires(!Ptr.box<i32>(alloc, 1).isNull());
  return 1;
}

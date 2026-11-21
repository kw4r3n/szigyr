// expect: E3004 @ 8:5
// stage: 3
type S = Struct<{ x: i32 }>;
export function f(alloc: Alloc, s: S): void {
  "use owned";
  "use unsafe";
  const p = Ptr.box(alloc, s);
  p.borrow().x = 1;
}

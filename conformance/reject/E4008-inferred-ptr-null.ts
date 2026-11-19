// expect: E4008 @ 7:13
// stage: 3
export function f(alloc: Alloc, c: boolean): void {
  "use owned";
  "use unsafe";
  const p = Ptr.box<i32>(alloc, 5);
  const x = c ? p : null;
}

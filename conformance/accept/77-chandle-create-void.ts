// expect: ok
// stage: 3
export function f(alloc: Alloc): void {
  "use owned";
  "use unsafe";
  const q = Ptr.box<i32>(alloc, 5).cast<void>();
  const h = CHandle.create<void>(q);
}

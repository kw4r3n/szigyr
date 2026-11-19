// expect: E4002 @ 6:25
// stage: 3
// open-question: Q199
function f(alloc: Alloc): void {
  "use owned";
  const p = Ring.create<OwnedCell<i32>>(alloc, 4);
}

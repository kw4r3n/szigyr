// expect: E4008 @ 7:21
// stage: 3
// open-question: Q228
function keep(alloc: Alloc, p: Ptr<i32>): void {
  "use owned";
  "use unsafe";
  const q = Ptr.box<Ptr<i32>>(alloc, p);
}

// expect: E2002 @ 6:25
// stage: 3
// open-question: Q210
function f(alloc: Alloc): void {
  "use owned";
  const p = Ring.create<ArenaBuf<i32>>(alloc, 4);
}

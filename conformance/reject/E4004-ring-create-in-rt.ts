// expect: E4004 @ 6:15
// stage: 3
// open-question: Q199
function f(): RingPair<i32> {
  "use rt";
  return Ring.create<i32>(TestAlloc.create(), 4);
}

// expect: E4002 @ 6:13
// stage: 3
// open-question: Q229
function make(alloc: Alloc): usize {
  "use owned";
  const v = Vec.create<null>(alloc, 4);
  return v.length;
}

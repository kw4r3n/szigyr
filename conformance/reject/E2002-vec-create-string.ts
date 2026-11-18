// expect: E2002 @ 5:24
// stage: 1
// open-question: Q086
function f(alloc: Alloc): usize {
  const v = Vec.create<string>(alloc, 1);
  return v.length;
}

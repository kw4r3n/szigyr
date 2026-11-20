// expect: E4002 @ 6:13
// stage: 3
// open-question: Q229
function grab(a: Mut<Arena>): usize {
  "use rt";
  const b = a.alloc<null>(2, null);
  return a.remaining;
}

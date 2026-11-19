// expect: E2002 @ 6:18
// stage: 2
// open-question: Q215
function g<T>(a: Mut<Arena>, x: T): ArenaBuf<T> | null {
  "use rt";
  return a.alloc<T>(2, x);
}

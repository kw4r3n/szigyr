// expect: E2002 @ 5:18
// stage: 2
// open-question: Q215
function g<T>(a: Mut<Arena>, x: T): ArenaBuf<T> | null {
  return a.alloc<T>(2, x);
}

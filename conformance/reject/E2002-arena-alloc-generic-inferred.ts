// expect: E2002 @ 6:12
// stage: 2
// open-question: Q215
function g<T>(a: Mut<Arena>, x: T): ArenaBuf<T> | null {
  "use owned";
  return a.alloc(2, x);
}

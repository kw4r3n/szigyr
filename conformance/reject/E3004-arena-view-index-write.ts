// expect: E3004 @ 6:5
// stage: 2
// open-question: Q222
export function f(a: Mut<Arena>, b: ArenaBuf<i32>): void {
  "use owned";
  a.view(b)[0] = 1;
}

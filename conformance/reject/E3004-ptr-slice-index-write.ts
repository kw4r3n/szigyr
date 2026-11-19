// expect: E3004 @ 7:5
// stage: 3
// open-question: Q222
export function f(p: Ptr<i32>): void {
  "use owned";
  "use unsafe";
  p.slice(4)[0] = 99;
}

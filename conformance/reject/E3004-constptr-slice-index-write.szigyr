// expect: E3004 @ 7:6
// stage: 3
// open-question: Q222
export function f(cp: ConstPtr<i32>): void {
  "use owned";
  "use unsafe";
  cp.slice(4)[0] = 99;
}

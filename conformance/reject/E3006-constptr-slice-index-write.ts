// expect: E3006 @ 6:3
// stage: 3
export function f(cp: ConstPtr<i32>): void {
  "use owned";
  "use unsafe";
  cp.slice(4)[0] = 99;
}

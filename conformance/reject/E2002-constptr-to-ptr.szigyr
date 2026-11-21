// expect: E2002 @ 10:8
// stage: 3
function take(p: Ptr<i32>): void {
  "use owned";
  "use unsafe";
}
export function f(p: ConstPtr<i32>): void {
  "use owned";
  "use unsafe";
  take(p);
}

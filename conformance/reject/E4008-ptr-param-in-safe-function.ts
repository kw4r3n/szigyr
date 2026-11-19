// expect: E4008 @ 3:22
// stage: 3
export function f(p: Ptr<i32>): i32 {
  "use owned";
  return 0;
}

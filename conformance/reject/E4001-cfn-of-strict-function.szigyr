// expect: E4001 @ 10:17
// stage: 3
function cb(x: i32): i32 {
  "use owned";
  return x;
}
export function reg(): void {
  "use owned";
  "use unsafe";
  const p = cfn(cb);
}

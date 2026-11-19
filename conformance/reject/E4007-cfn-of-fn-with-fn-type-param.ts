// expect: E4007 @ 10:17
// stage: 3
function cb(g: (x: i32) => i32, x: i32): i32 {
  "use rt";
  return x;
}
export function reg(): void {
  "use owned";
  "use unsafe";
  const p = cfn(cb);
}

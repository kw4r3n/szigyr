// expect: E4008 @ 9:13
// stage: 3
function cb(x: i32): i32 {
  "use rt";
  return x;
}
export function reg(): void {
  "use owned";
  const p = cfn(cb);
}

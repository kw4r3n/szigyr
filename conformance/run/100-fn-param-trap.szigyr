// expect-trap: T001 @ 5:12
// stage: 2
function boom(x: i32): i32 {
  "use rt";
  return x + x;
}
function applyRt(f: (x: i32) => i32, v: i32): i32 {
  "use rt";
  return f(v);
}
export function main(sys: System): void {
  const r = applyRt(boom, 2000000000);
  sys.log.info(`${r}`);
}

// expect: E2011 @ 7:31
// stage: 3
function w(port: Port<i32, i32>): i32 {
  return 0;
}
export function main(sys: System): void {
  const p = sys.spawn.isolate(w);
}

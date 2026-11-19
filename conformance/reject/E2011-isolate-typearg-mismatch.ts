// expect: E2011 @ 5:44
// stage: 3
function w(port: Port<i32, i32>): void {}
export function main(sys: System): void {
  const p = sys.spawn.isolate<string, i32>(w);
}

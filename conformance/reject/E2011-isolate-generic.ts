// expect: E2011 @ 5:31
// stage: 3
function w<T>(port: Port<i32, i32>): void {}
export function main(sys: System): void {
  const p = sys.spawn.isolate(w);
}

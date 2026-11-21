// expect: E2011 @ 7:31
// stage: 3
function w(x: i32): void {
  "use owned";
}
export function main(sys: System): void {
  const p = sys.spawn.isolate(w);
}

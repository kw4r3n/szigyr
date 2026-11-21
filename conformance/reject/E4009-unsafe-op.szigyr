// expect: E4009 @ 3:18
// stage: 3
function take(p: Ptr<i32>): i32 {
  "use owned";
  "use unsafe";
  return p.read();
}
export function main(sys: System): void {
  sys.log.info("x");
}

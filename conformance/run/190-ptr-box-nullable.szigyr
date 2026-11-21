// expect-output: 99
// expect-output: -1
// stage: 3
// backend: c
function go(alloc: Alloc, n: i32): i32 {
  "use owned";
  "use unsafe";
  const p = Ptr.box<i32 | null>(alloc, n);
  return p.unbox() ?? -1;
}
function go0(alloc: Alloc, x: i32 | null): i32 {
  "use owned";
  "use unsafe";
  const p = Ptr.box<i32 | null>(alloc, x);
  const v = p.unbox();
  if (v === null) {
    return -1;
  }
  return v;
}
export function main(sys: System): void {
  sys.log.info(`${go(sys.alloc, 99)}`);
  sys.log.info(`${go0(sys.alloc, null)}`);
}

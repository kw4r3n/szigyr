// expect-output: 5
// stage: 3
// backend: c
type S = Struct<{ x: i32 }>;
function take(s: S): i32 {
  "use owned";
  return s.x;
}
function go(alloc: Alloc): i32 {
  "use owned";
  "use unsafe";
  const p = Ptr.box<S>(alloc, { x: 5 });
  return take(p.unbox());
}
export function main(sys: System): void {
  sys.log.info(`${go(sys.alloc)}`);
}

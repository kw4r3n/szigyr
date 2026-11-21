// expect-output: 1
// stage: 2
function two(a: Mut<Slice<u8>>, b: Mut<Slice<f64>>): void {
  "use rt";
  a.fill(1);
  b.fill(2);
}
function go(alloc: Alloc): i32 {
  "use owned";
  const ar = Arena.create(alloc, 256);
  const x = ar.alloc<u8>(8, 0);
  const y = ar.alloc<f64>(1, 0);
  if (x === null || y === null) { return 0; }
  two(ar.view(x), ar.view(y));
  return 1;
}
export function main(sys: System): void { sys.log.info(`${go(sys.alloc)}`); }

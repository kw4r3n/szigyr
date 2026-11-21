// expect-output: 42
// stage: 3
// backend: c
declare module "c:sqlite3:sqlite3.h" {
  function sqlite3_libversion_number(ffi: Ffi): i32;
}
function add(a: i32, b: i32): i32 {
  "use owned";
  return a + b;
}
export function main(sys: System): void {
  sys.log.info(`${add(20, 22)}`);
}

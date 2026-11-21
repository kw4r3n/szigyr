// expect-trap: T003 @ 12:10
// stage: 3
// backend: c
declare module "c:zlib:zlib.h" {
  function compressBound(ffi: Ffi, sourceLen: usize): usize;
}
import { compressBound } from "c:zlib:zlib.h";

function go(ffi: Ffi): usize {
  "use owned";
  "use unsafe";
  return compressBound(ffi, 4294967295);
}
export function main(sys: System): void {
  sys.log.info(`${go(sys.ffi)}`);
}

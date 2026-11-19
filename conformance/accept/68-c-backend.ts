// expect: ok
// stage: 3
// backend: c
declare module "c:sqlite3:sqlite3.h" {
  function sqlite3_libversion_number(ffi: Ffi): i32;
}
import { sqlite3_libversion_number } from "c:sqlite3:sqlite3.h";
export function version(ffi: Ffi): i32 {
  "use owned";
  "use unsafe";
  return sqlite3_libversion_number(ffi);
}

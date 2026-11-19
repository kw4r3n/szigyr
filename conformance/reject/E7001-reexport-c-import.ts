// expect: E7001 @ 7:10
// stage: 3
declare module "c:sqlite3:sqlite3.h" {
  function sqlite3_libversion_number(ffi: Ffi): i32;
}
import { sqlite3_libversion_number } from "c:sqlite3:sqlite3.h";
export { sqlite3_libversion_number };

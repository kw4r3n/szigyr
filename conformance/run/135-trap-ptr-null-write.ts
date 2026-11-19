// expect-trap: T015 @ 12:6
// stage: 3
// backend: c
declare module "c:sqlite3:sqlite3.h" {
  function sqlite3_malloc(ffi: Ffi, n: i32): Ptr<void>;
}
import { sqlite3_malloc } from "c:sqlite3:sqlite3.h";
function go(ffi: Ffi): void {
  "use owned";
  "use unsafe";
  const np = sqlite3_malloc(ffi, 0).cast<i32>();
  np.write(1);
}
export function main(sys: System): void {
  go(sys.ffi);
  sys.log.info("unreachable");
}

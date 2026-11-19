// expect-trap: T015 @ 12:14
// stage: 3
// backend: c
declare module "c:sqlite3:sqlite3.h" {
  function sqlite3_malloc(ffi: Ffi, n: i32): Ptr<void>;
}
import { sqlite3_malloc } from "c:sqlite3:sqlite3.h";
function go(ffi: Ffi): i32 {
  "use owned";
  "use unsafe";
  const np = sqlite3_malloc(ffi, 0).cast<i32>();
  return np.read();
}
export function main(sys: System): void {
  sys.log.info(`${go(sys.ffi)}`);
}

// expect-trap: T015 @ 16:17
// stage: 3
// backend: c
declare module "c:sqlite3:sqlite3.h" {
  function sqlite3_malloc(ffi: Ffi, n: i32): Ptr<void>;
}
import { sqlite3_malloc } from "c:sqlite3:sqlite3.h";
function sum(s: Ref<Slice<i32>>): i32 {
  "use rt";
  return s[0];
}
function go(ffi: Ffi): i32 {
  "use owned";
  "use unsafe";
  const np = sqlite3_malloc(ffi, 0).cast<i32>();
  return sum(np.slice(1));
}
export function main(sys: System): void {
  sys.log.info(`${go(sys.ffi)}`);
}

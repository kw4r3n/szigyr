// expect-trap: T002 @ 12:15
// stage: 3
// backend: c
declare module "c:sqlite3:sqlite3.h" {
  function sqlite3_malloc(ffi: Ffi, n: i32): Ptr<void>;
}
import { sqlite3_malloc } from "c:sqlite3:sqlite3.h";
function go(ffi: Ffi, s: Ref<Slice<usize>>): void {
  "use owned";
  "use unsafe";
  const np = sqlite3_malloc(ffi, 0).cast<i32>();
  np.offset(s[s.length]);
}
export function main(sys: System): void {
  const v = Vec.create<usize>(sys.alloc, 1);
  v.push(0);
  go(sys.ffi, v);
}

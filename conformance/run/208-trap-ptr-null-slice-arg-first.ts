// expect-trap: T002 @ 16:25
// stage: 3
// backend: c
declare module "c:sqlite3:sqlite3.h" {
  function sqlite3_malloc(ffi: Ffi, n: i32): Ptr<void>;
}
import { sqlite3_malloc } from "c:sqlite3:sqlite3.h";
function sum(t: Ref<Slice<i32>>): i32 {
  "use rt";
  return t[0];
}
function go(ffi: Ffi, s: Ref<Slice<usize>>): i32 {
  "use owned";
  "use unsafe";
  const np = sqlite3_malloc(ffi, 0).cast<i32>();
  return sum(np.slice(s[s.length]));
}
export function main(sys: System): void {
  const v = Vec.create<usize>(sys.alloc, 1);
  v.push(0);
  sys.log.info(`${go(sys.ffi, v)}`);
}

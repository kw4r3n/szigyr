// expect-trap: T015 @ 17:18
// stage: 3
// backend: c
declare module "c:sqlite3:sqlite3.h" {
  function sqlite3_malloc(ffi: Ffi, n: i32): Ptr<void>;
}
import { sqlite3_malloc } from "c:sqlite3:sqlite3.h";
function peek(rx: Mut<RingRx<i32>>): i32 {
  "use rt";
  const v = rx.pop();
  return v === null ? 0 : v;
}
function go(ffi: Ffi): i32 {
  "use owned";
  "use unsafe";
  const np = sqlite3_malloc(ffi, 0).cast<RingRx<i32>>();
  return peek(np.borrow());
}
export function main(sys: System): void {
  sys.log.info(`${go(sys.ffi)}`);
}

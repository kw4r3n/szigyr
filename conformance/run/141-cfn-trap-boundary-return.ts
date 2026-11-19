// expect-output: before
// expect-trap: T001 @ 13:12
// stage: 3
// backend: c
// open-question: Q217
declare module "c:stscb:stscb.h" {
  function stscb_thread(ffi: Ffi, f: Ptr<(ud: Ptr<void>, x: i32) => i32>, ud: Ptr<void>, x: i32): i32;
}
import { stscb_thread } from "c:stscb:stscb.h";

function boom(ud: Ptr<void>, x: i32): i32 {
  "use rt";
  "use unsafe";
  return x + 1;
}
function go(ffi: Ffi, alloc: Alloc): i32 {
  "use owned";
  "use unsafe";
  const ud = Ptr.box(alloc, 0);
  return stscb_thread(ffi, cfn(boom), ud.cast<void>(), 2147483647);
}
export function main(sys: System): void {
  sys.log.info("before");
  const r = go(sys.ffi, sys.alloc);
  sys.log.info(`${r}`);
}

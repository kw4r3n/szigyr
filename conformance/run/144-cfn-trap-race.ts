// expect-output: before
// expect-trap: T001 @ 13:12
// stage: 3
// backend: c
// open-question: Q217
declare module "c:stscb:stscb.h" {
  function stscb_race(ffi: Ffi, f: Ptr<(ud: Ptr<void>, x: i32) => i32>, ud: Ptr<void>, g: Ptr<(ud: Ptr<void>, x: i32) => i32>, gud: Ptr<void>, x: i32): void;
}
import { stscb_race } from "c:stscb:stscb.h";

function boom(ud: Ptr<void>, x: i32): i32 {
  "use rt";
  "use unsafe";
  return x + 1;
}
function go(ffi: Ffi, alloc: Alloc): void {
  "use owned";
  "use unsafe";
  const ud = Ptr.box(alloc, 0);
  stscb_race(ffi, cfn(boom), ud.cast<void>(), cfn(boom), ud.cast<void>(), 2147483647);
}
export function main(sys: System): void {
  sys.log.info("before");
  go(sys.ffi, sys.alloc);
  sys.log.info("after");
}

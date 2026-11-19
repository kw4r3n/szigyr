// expect-output: before
// expect-trap: T003 @ 11:29
// stage: 3
// backend: c
// open-question: Q217
declare module "c:stscb:stscb.h" {
  function stscb_call_big(ffi: Ffi, f: Ptr<(ud: Ptr<void>, n: usize) => usize>, ud: Ptr<void>): usize;
}
import { stscb_call_big } from "c:stscb:stscb.h";

function big(ud: Ptr<void>, n: usize): usize {
  "use rt";
  "use unsafe";
  return n;
}
function go(ffi: Ffi, alloc: Alloc): usize {
  "use owned";
  "use unsafe";
  const ud = Ptr.box(alloc, 0);
  return stscb_call_big(ffi, cfn(big), ud.cast<void>());
}
export function main(sys: System): void {
  sys.log.info("before");
  const r = go(sys.ffi, sys.alloc);
  sys.log.info(`${r}`);
}

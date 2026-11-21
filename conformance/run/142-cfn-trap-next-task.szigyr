// expect-output: armed
// expect-trap: T001 @ 14:12
// stage: 3
// backend: c
// open-question: Q217
declare module "c:stscb:stscb.h" {
  function stscb_start(ffi: Ffi, f: Ptr<(ud: Ptr<void>, x: i32) => i32>, ud: Ptr<void>, x: i32, delay: i32, after: Ptr<(ud: Ptr<void>, x: i32) => i32>, aud: Ptr<void>): void;
}
import { stscb_start } from "c:stscb:stscb.h";

function boom(ud: Ptr<void>, x: i32): i32 {
  "use rt";
  "use unsafe";
  return x + 1;
}
function noop(ud: Ptr<void>, x: i32): i32 {
  "use rt";
  "use unsafe";
  return 0;
}
function arm(ffi: Ffi, alloc: Alloc): void {
  "use owned";
  "use unsafe";
  const ud = Ptr.box(alloc, 0);
  stscb_start(ffi, cfn(boom), ud.cast<void>(), 2147483647, 50, cfn(noop), ud.cast<void>());
}
async function tick(): Promise<void> {}
export async function main(sys: System): Promise<void> {
  arm(sys.ffi, sys.alloc);
  sys.log.info("armed");
  let i: i32 = 0;
  while (i < 5000000) {
    await tick();
    i += 1;
  }
  sys.log.info("after");
}

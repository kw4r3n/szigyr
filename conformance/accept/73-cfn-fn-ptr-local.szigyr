// expect: ok
// stage: 3
declare module "c:stscb:stscb.h" {
  function stscb_call(ffi: Ffi, f: Ptr<(ud: Ptr<void>, x: i32) => i32>, ud: Ptr<void>, x: i32): i32;
}
import { stscb_call } from "c:stscb:stscb.h";

function cb(ud: Ptr<void>, x: i32): i32 {
  "use rt";
  "use unsafe";
  return x + 1;
}
export function reg(ffi: Ffi, ud: Ptr<void>): i32 {
  "use owned";
  "use unsafe";
  const p: Ptr<(ud: Ptr<void>, x: i32) => i32> = cfn(cb);
  return stscb_call(ffi, p, ud, 1) + stscb_call(ffi, p, ud, 2);
}

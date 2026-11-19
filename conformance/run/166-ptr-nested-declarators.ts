// expect-output: 5054202
// stage: 3
// backend: c
declare module "c:stscb:stscb_audit.h" {
  function stscb_cpp(ffi: Ffi, p: ConstPtr<Ptr<i32>>): i32;
  function stscb_cppp(ffi: Ffi, p: ConstPtr<Ptr<Ptr<i32>>>): i32;
  function stscb_ppfn(ffi: Ffi, p: Ptr<Ptr<(x: i32) => i32>>): i32;
  function stscb_cpfn(ffi: Ffi, p: ConstPtr<Ptr<(x: i32) => i32>>): i32;
}
import { stscb_cpp, stscb_cppp, stscb_ppfn, stscb_cpfn } from "c:stscb:stscb_audit.h";
function inc(x: i32): i32 {
  "use rt";
  return x + 1;
}
function go(ffi: Ffi, alloc: Alloc): i32 {
  "use owned";
  "use unsafe";
  const p = Ptr.box<i32>(alloc, 5);
  const pp = Ptr.box(alloc, p);
  const ppp = Ptr.box(alloc, pp);
  const fp = Ptr.box(alloc, cfn(inc));
  return stscb_cpp(ffi, pp) * 1000000 + stscb_cppp(ffi, ppp) * 10000 + stscb_ppfn(ffi, fp) * 100 + stscb_cpfn(ffi, fp);
}
export function main(sys: System): void {
  sys.log.info(`${go(sys.ffi, sys.alloc)}`);
}

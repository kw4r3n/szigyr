// expect: E4008 @ 9:10
// stage: 3
declare module "c:foo:foo.h" {
  function cfun(ffi: Ffi, x: i32): i32;
}
import { cfun } from "c:foo:foo.h";
export function f(ffi: Ffi, x: i32): i32 {
  "use owned";
  return cfun(ffi, x);
}

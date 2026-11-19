// expect: ok
// stage: 3
declare module "c:foo:foo.h" {
  function onEvent(ffi: Ffi, cb: Ptr<(x: i32) => i32>): void;
}
import { onEvent } from "c:foo:foo.h";

function cb(x: i32): i32 {
  "use rt";
  return x + 1;
}
export function register(ffi: Ffi): void {
  "use owned";
  "use unsafe";
  onEvent(ffi, cfn(cb));
}
export function anyPtr(p: Ptr<void>): boolean {
  "use owned";
  "use unsafe";
  return p.isNull();
}

// expect: E4008 @ 13:12
// stage: 3
declare module "c:foo:foo.h" {
  function make(ffi: Ffi): Ptr<i32>;
}
import { make } from "c:foo:foo.h";
function open(ffi: Ffi): CHandle<i32> {
  "use owned";
  "use unsafe";
  return CHandle.create(make(ffi));
}
export function peek(h: CHandle<i32>): boolean {
  return h.get().isNull();
}

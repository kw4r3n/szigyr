// expect: E3008 @ 19:16
// stage: 3
declare module "c:foo:foo.h" {
  function make(ffi: Ffi): Ptr<i32>;
}
import { make } from "c:foo:foo.h";
function first(s: Ref<Slice<i32>>): i32 {
  "use rt";
  return s[0];
}
function open(ffi: Ffi): CHandle<i32> {
  "use owned";
  "use unsafe";
  return CHandle.create(make(ffi));
}
export function f(h: CHandle<i32>): i32 {
  "use owned";
  "use unsafe";
  return first(h.get().slice(4));
}

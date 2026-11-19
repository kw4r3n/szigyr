// expect: ok
// stage: 3
declare module "c:foo:foo.h" {
  function cfun(ffi: Ffi, x: i32): i32;
}
import { cfun } from "c:foo:foo.h";

function rtPlain(x: i32): i32 {
  "use rt";
  return x;
}
function rtUnsafe(x: i32): i32 {
  "use rt";
  "use unsafe";
  return cfun(x) + rtPlain(x);
}
function rtUnsafe2(x: i32): i32 {
  "use unsafe";
  "use rt";
  return rtUnsafe(x);
}
function strictUnsafe(ffi: Ffi, x: i32): i32 {
  "use owned";
  "use unsafe";
  return cfun(ffi, x);
}
function strictPlain(ffi: Ffi, x: i32): i32 {
  "use owned";
  return strictUnsafe(ffi, x);
}
export function top(ffi: Ffi, x: i32): i32 {
  return strictUnsafe(ffi, x) + strictPlain(ffi, x);
}

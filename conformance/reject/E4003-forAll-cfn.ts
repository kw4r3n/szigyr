// expect: E4003 @ 8:10
// stage: 4
declare module "c:foo:foo.h" {
  function cfun(ffi: Ffi, x: i32): i32;
}
import { cfun } from "c:foo:foo.h";
test("t", (t: Test) => {
  forAll(cfun);
});

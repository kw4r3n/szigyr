// expect: E4007 @ 4:31
// stage: 3
declare module "c:foo:foo.h" {
  function f(ffi: Ffi, p: Ptr<usize>): void;
}

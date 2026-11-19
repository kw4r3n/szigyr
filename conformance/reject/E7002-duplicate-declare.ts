// expect: E7002 @ 6:16
// stage: 3
declare module "c:foo:foo.h" {
  function f(ffi: Ffi): void;
}
declare module "c:foo:foo.h" {
  function g(ffi: Ffi): void;
}

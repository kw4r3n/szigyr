// expect: E2009 @ 3:16
// stage: 3
declare module "c:sdl3:SDL3/sts-no-such-header.h" {
  function f(ffi: Ffi): void;
}

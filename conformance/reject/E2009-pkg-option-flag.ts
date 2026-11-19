// expect: E2009 @ 3:16
// stage: 3
declare module "c:--version:zlib.h" {
  function compressBound(ffi: Ffi, sourceLen: usize): usize;
}

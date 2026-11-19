// expect: E7002 @ 4:16
// stage: 3
// open-question: Q224
declare module "c:zlib:zlib.h\n" {
  function compressBound(ffi: Ffi, sourceLen: usize): usize;
}

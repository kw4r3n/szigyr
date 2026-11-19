// expect: E2009 @ 4:12
// stage: 3
declare module "c:sdl3:SDL3/SDL.h" {
  function SDL_snprintf(ffi: Ffi, text: Ptr<void>, maxlen: usize, fmt: ConstPtr<void>): i32;
}

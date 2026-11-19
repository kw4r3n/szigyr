// expect: E2009 @ 4:12
// stage: 3
declare module "c:sdl3:SDL3/SDL.h" {
  function SDL_no_such_function(ffi: Ffi): void;
}

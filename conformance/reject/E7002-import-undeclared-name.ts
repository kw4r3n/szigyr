// expect: E7002 @ 6:10
// stage: 3
declare module "c:sdl3:SDL3/SDL.h" {
  function f(ffi: Ffi): void;
}
import { g } from "c:sdl3:SDL3/SDL.h";

// expect: ok
// stage: 3
declare module "c:sdl3:SDL3/SDL.h" {
  function SDL_toupper(ffi: Ffi, x: i32): i32;
}
import { SDL_toupper } from "c:sdl3:SDL3/SDL.h";

function rtPlain(x: i32): i32 {
  "use rt";
  return x;
}
function rtUnsafe(x: i32): i32 {
  "use rt";
  "use unsafe";
  return SDL_toupper(x) + rtPlain(x);
}
function rtUnsafe2(x: i32): i32 {
  "use unsafe";
  "use rt";
  return rtUnsafe(x);
}
function strictUnsafe(ffi: Ffi, x: i32): i32 {
  "use owned";
  "use unsafe";
  return SDL_toupper(ffi, x);
}
function strictPlain(ffi: Ffi, x: i32): i32 {
  "use owned";
  return strictUnsafe(ffi, x);
}
export function top(ffi: Ffi, x: i32): i32 {
  return strictUnsafe(ffi, x) + strictPlain(ffi, x);
}

// expect: ok
// stage: 3
declare module "c:sdl3:SDL3/SDL.h" {
  function SDL_malloc(ffi: Ffi, size: usize): Ptr<void>;
  function SDL_free(ffi: Ffi, mem: Ptr<void>): void;
  function SDL_IOFromMem(ffi: Ffi, mem: Ptr<void>, size: usize): Ptr<CType<"SDL_IOStream">>;
  function SDL_WriteIO(ffi: Ffi, context: Ptr<CType<"SDL_IOStream">>, src: ConstPtr<void>, size: usize): usize;
  function SDL_ReadIO(ffi: Ffi, context: Ptr<CType<"SDL_IOStream">>, ptr: Ptr<void>, size: usize): usize;
  function SDL_CloseIO(ffi: Ffi, context: Ptr<CType<"SDL_IOStream">>): boolean;
  function SDL_floor(ffi: Ffi, x: f64): f64;
  function SDL_GetNumVideoDrivers(ffi: Ffi): i32;
  function SDL_AddTimer(ffi: Ffi, interval: u32, callback: Ptr<(userdata: Ptr<void>, timerID: u32, interval: u32) => u32>, param: Ptr<void>): u32;
}
import { SDL_malloc, SDL_free, SDL_IOFromMem, SDL_WriteIO, SDL_ReadIO, SDL_CloseIO, SDL_floor, SDL_GetNumVideoDrivers, SDL_AddTimer } from "c:sdl3:SDL3/SDL.h";

function onTimer(userdata: Ptr<void>, timerID: u32, interval: u32): u32 {
  "use rt";
  "use unsafe";
  return interval;
}
export function roundTrip(ffi: Ffi): i32 {
  "use owned";
  "use unsafe";
  const buf = SDL_malloc(ffi, 16);
  const w = SDL_IOFromMem(ffi, buf, 16);
  const wrote = SDL_WriteIO(ffi, w, buf, 5);
  const c1 = SDL_CloseIO(ffi, w);
  const r = SDL_IOFromMem(ffi, buf, 16);
  const got = SDL_ReadIO(ffi, r, buf, 5);
  const c2 = SDL_CloseIO(ffi, r);
  const drivers = SDL_GetNumVideoDrivers(ffi);
  const timer = SDL_AddTimer(ffi, 100, cfn(onTimer), buf);
  SDL_free(ffi, buf);
  return i32(wrote + got) + i32(SDL_floor(ffi, 2.5)) + drivers + i32(timer);
}

// expect: ok
// stage: 3
declare module "c:sdl3:SDL3/SDL.h" {
  function SDL_AddTimer(ffi: Ffi, interval: u32, callback: Ptr<(userdata: Ptr<void>, timerID: u32, interval: u32) => u32>, param: Ptr<void>): u32;
}
import { SDL_AddTimer } from "c:sdl3:SDL3/SDL.h";

function cb(userdata: Ptr<void>, timerID: u32, interval: u32): u32 {
  "use rt";
  "use unsafe";
  return interval;
}
export function register(ffi: Ffi, p: Ptr<void>): void {
  "use owned";
  "use unsafe";
  SDL_AddTimer(ffi, 100, cfn(cb), p);
}
export function anyPtr(p: Ptr<void>): boolean {
  "use owned";
  "use unsafe";
  return p.isNull();
}

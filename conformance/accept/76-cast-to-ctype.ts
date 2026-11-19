// expect: ok
// stage: 3
// open-question: Q219
declare module "c:sdl3:SDL3/SDL.h" {
  function SDL_malloc(ffi: Ffi, size: usize): Ptr<void>;
  function SDL_OpenAudioDeviceStream(ffi: Ffi, dev: u32, spec: ConstPtr<CType<"SDL_AudioSpec">>, callback: Ptr<(user: Ptr<void>, stream: Ptr<CType<"SDL_AudioStream">>, additional: i32, total: i32) => void>, userdata: Ptr<void>): Ptr<CType<"SDL_AudioStream">>;
}
import { SDL_malloc, SDL_OpenAudioDeviceStream } from "c:sdl3:SDL3/SDL.h";

function cb(user: Ptr<void>, stream: Ptr<CType<"SDL_AudioStream">>, additional: i32, total: i32): void {
  "use rt";
  "use unsafe";
}

// The spec struct is built in C memory by the caller, so its pointer has to
// come from a cast: a cast target is a pointee position (Q219).
export function open(ffi: Ffi, userdata: Ptr<void>): Ptr<CType<"SDL_AudioStream">> {
  "use owned";
  "use unsafe";
  const mem = SDL_malloc(ffi, 16);
  const spec = mem.cast<CType<"SDL_AudioSpec">>();
  return SDL_OpenAudioDeviceStream(ffi, 4294967295, spec, cfn(cb), userdata);
}

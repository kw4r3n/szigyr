// expect: ok
// stage: 3
declare module "c:sdl3:SDL3/SDL.h" {
  function SDL_malloc(ffi: Ffi, size: usize): Ptr<void>;
}
declare module "c:zlib:zlib.h" {
  function crc32(ffi: Ffi, crc: usize, buf: ConstPtr<u8>, len: u32): usize;
}
import { SDL_malloc } from "c:sdl3:SDL3/SDL.h";
import { crc32 } from "c:zlib:zlib.h";

type State = Struct<{ readonly phase: f32 }>;

function readFirst(s: Ref<Slice<i32>>): i32 {
  "use rt";
  return s[0];
}
function writeFirst(s: Mut<Slice<i32>>): void {
  "use rt";
  s[0] = 7;
}
export function open(ffi: Ffi): CHandle<i32> {
  "use owned";
  "use unsafe";
  const raw = SDL_malloc(ffi, 16);
  const p = raw.cast<i32>();
  if (!p.isNull()) {
    p.write(41);
    const q: ConstPtr<i32> = p;
    crc32(ffi, 0, q.cast<u8>(), 4);
    const r = readFirst(p.slice(2));
    const s2 = p.offset(1).read();
    writeFirst(p.slice(2));
    const cp = p.cast<f32>();
    const empty = cp.isNull();
    if (r === s2 && !empty) {
      p.write(r);
    }
  }
  return CHandle.create(p);
}
export function roundTrip(alloc: Alloc, s: State): State {
  "use owned";
  "use unsafe";
  const p = Ptr.box(alloc, s);
  return p.unbox();
}

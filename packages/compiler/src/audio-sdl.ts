// Node Audio host over SDL3 (loaded lazily at runtime via dlopen; no build-time SDL3 dependency, Q284).
import * as rt from "../../runtime-js/src/index.ts";
import { err, ok, Slice } from "../../runtime-js/src/index.ts";
import type { Audio, AudioCallbackSpec, AudioConfig, AudioStream } from "../../std/src/types.ts";
import { loadNative } from "./native.ts";

const activeClosers = new Set<() => Promise<void>>();

/** Stops every still-open AudioStream when `main` ends (§15.5, Q283). */
export async function stopAudioStreams(): Promise<void> {
  const fns = [...activeClosers];
  for (const fn of fns) await fn();
}

const SDL_PUSH_C = `
#include <node_api.h>
#include <dlfcn.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <stdatomic.h>

typedef struct { uint32_t format; int channels; int freq; } sz_sdl_spec;
static struct {
  int tried, ok; const char *ec, *em; void *lib;
  bool (*InitSubSystem)(uint32_t);
  void (*QuitSubSystem)(uint32_t);
  uint32_t (*WasInit)(uint32_t);
  void (*Quit)(void);
  void *(*OpenAudioDeviceStream)(uint32_t, const sz_sdl_spec *, void *, void *);
  bool (*ResumeAudioStreamDevice)(void *);
  bool (*PutAudioStreamData)(void *, const void *, int);
  int (*GetAudioStreamQueued)(void *);
  void (*DestroyAudioStream)(void *);
  const char *(*GetError)(void);
} sdl;

static bool load_sdl(const char **ec, const char **em) {
  if (sdl.ok) return true;
  if (sdl.tried) { *ec = sdl.ec; *em = sdl.em; return false; }
  sdl.tried = 1;
  void *h = dlopen("libSDL3.so.0", RTLD_LAZY | RTLD_LOCAL);
  if (!h) h = dlopen("libSDL3.so", RTLD_LAZY | RTLD_LOCAL);
  if (!h) { const char *d = dlerror(); sdl.ec = "ENOENT"; sdl.em = d ? d : "libSDL3.so.0 not found"; *ec = sdl.ec; *em = sdl.em; return false; }
  sdl.lib = h;
  #define SYM(n) if (!(sdl.n = dlsym(h, "SDL_" #n))) { sdl.ec = "EIO"; sdl.em = "missing symbol SDL_" #n; *ec = sdl.ec; *em = sdl.em; return false; }
  SYM(InitSubSystem) SYM(QuitSubSystem) SYM(WasInit) SYM(Quit) SYM(OpenAudioDeviceStream) SYM(ResumeAudioStreamDevice)
  SYM(PutAudioStreamData) SYM(GetAudioStreamQueued) SYM(DestroyAudioStream) SYM(GetError)
  #undef SYM
  sdl.ok = 1; return true;
}

typedef struct { void *stream; _Atomic int closed; } sz_pstream;
static void quit_if_idle(void) { sdl.QuitSubSystem(0x10u); if (!sdl.WasInit(0)) sdl.Quit(); }
static void fin_ps(napi_env env, void *data, void *hint) {
  (void)env; (void)hint; sz_pstream *ps = (sz_pstream *)data;
  if (!atomic_exchange(&ps->closed, 1) && ps->stream) { sdl.DestroyAudioStream(ps->stream); ps->stream = 0; quit_if_idle(); }
  free(ps);
}
static napi_value err_obj(napi_env env, const char *code, const char *msg) {
  napi_value o, v; napi_create_object(env, &o);
  napi_create_string_utf8(env, code ? code : "EIO", NAPI_AUTO_LENGTH, &v); napi_set_named_property(env, o, "code", v);
  napi_create_string_utf8(env, msg ? msg : "audio error", NAPI_AUTO_LENGTH, &v); napi_set_named_property(env, o, "error", v);
  return o;
}
static napi_value n_init(napi_env env, napi_callback_info info) { (void)env; (void)info; return 0; }
static napi_value n_open(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value argv[2]; napi_get_cb_info(env, info, &argc, argv, 0, 0);
  uint32_t rate = 0, ch = 0; napi_get_value_uint32(env, argv[0], &rate); napi_get_value_uint32(env, argv[1], &ch);
  const char *ec = 0, *em = 0;
  if (!load_sdl(&ec, &em)) return err_obj(env, ec, em);
  if (!sdl.InitSubSystem(0x10u)) { const char *m = sdl.GetError(); return err_obj(env, "EIO", m && *m ? m : "SDL_InitSubSystem failed"); }
  sz_sdl_spec spec = { 0x8120u, (int)ch, (int)rate };
  void *s = sdl.OpenAudioDeviceStream(0xFFFFFFFFu, &spec, 0, 0);
  if (!s) { const char *m = sdl.GetError(); quit_if_idle(); return err_obj(env, "EIO", m && *m ? m : "SDL_OpenAudioDeviceStream failed"); }
  if (!sdl.ResumeAudioStreamDevice(s)) { const char *m = sdl.GetError(); sdl.DestroyAudioStream(s); quit_if_idle(); return err_obj(env, "EIO", m && *m ? m : "SDL_ResumeAudioStreamDevice failed"); }
  sz_pstream *ps = calloc(1, sizeof *ps); ps->stream = s;
  napi_value ext; napi_create_external(env, ps, fin_ps, 0, &ext); return ext;
}
static napi_value n_queued(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1]; napi_get_cb_info(env, info, &argc, argv, 0, 0);
  void *p = 0; napi_get_value_external(env, argv[0], &p);
  sz_pstream *ps = (sz_pstream *)p;
  napi_value r; napi_create_int32(env, ps && ps->stream ? sdl.GetAudioStreamQueued(ps->stream) : -1, &r); return r;
}
static napi_value n_put(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value argv[2]; napi_get_cb_info(env, info, &argc, argv, 0, 0);
  void *p = 0; napi_get_value_external(env, argv[0], &p);
  sz_pstream *ps = (sz_pstream *)p;
  if (!ps || !ps->stream || atomic_load(&ps->closed)) { napi_value b; napi_get_boolean(env, false, &b); return b; }
  napi_typedarray_type tt; size_t len, off; void *data; napi_value ab;
  napi_get_typedarray_info(env, argv[1], &tt, &len, &data, &ab, &off);
  bool ok = sdl.PutAudioStreamData(ps->stream, data, (int)(len * sizeof(float)));
  napi_value r; napi_get_boolean(env, ok, &r); return r;
}
static napi_value n_close(napi_env env, napi_callback_info info) {
  (void)env; size_t argc = 1; napi_value argv[1]; napi_get_cb_info(env, info, &argc, argv, 0, 0);
  void *p = 0; if (napi_get_value_external(env, argv[0], &p) == napi_ok && p) {
    sz_pstream *ps = (sz_pstream *)p;
    if (!atomic_exchange(&ps->closed, 1) && ps->stream) { sdl.DestroyAudioStream(ps->stream); ps->stream = 0; quit_if_idle(); }
  }
  return 0;
}
NAPI_MODULE_INIT() {
  napi_value f;
  #define EXP(n, fn) napi_create_function(env, n, NAPI_AUTO_LENGTH, fn, 0, &f); napi_set_named_property(env, exports, n, f)
  EXP("init", n_init); EXP("open", n_open); EXP("queued", n_queued); EXP("put", n_put); EXP("close", n_close);
  return exports;
}
`;

let pushAddon: Record<string, (...a: unknown[]) => unknown> | undefined;
const sdlPush = (): Record<string, (...a: unknown[]) => unknown> => (pushAddon ??= loadNative(SDL_PUSH_C, {}));
const errOut = (v: unknown): { code: string; error: string } | undefined =>
  v !== null && typeof v === "object" && "error" in (v as Record<string, unknown>) ? (v as { code: string; error: string }) : undefined;

/** Creates the Node host `Audio` implementation using SDL3. */
export function createNodeAudio(): Audio {
  return {
    async open(config: AudioConfig, state: unknown, cb: AudioCallbackSpec) {
      if (!Number.isInteger(config.sampleRate) || config.sampleRate <= 0 || config.sampleRate > 0x7fffffff || !Number.isInteger(config.channels) || config.channels < 1 || config.channels > 32) {
        return err({ code: "EINVAL", message: `invalid audio config: sampleRate=${config.sampleRate}, channels=${config.channels}` });
      }
      const { sampleRate, channels } = config;
      const cOpen = cb.native?.[`sz_audio_open_${cb.id}`] as ((r: number, c: number, s: unknown) => unknown) | undefined;
      const cClose = cb.native?.[`sz_audio_close_${cb.id}`] as ((h: unknown) => void) | undefined;
      if (cOpen && cClose) {
        const res = cOpen(sampleRate, channels, state);
        const e = errOut(res);
        if (e) return err({ code: e.code, message: e.error });
        let closed = false;
        const close = async (): Promise<void> => {
          if (closed) return;
          closed = true;
          activeClosers.delete(close);
          cClose(res);
        };
        activeClosers.add(close);
        const stream: AudioStream = { sampleRate, channels, close, disposeAsync: close, isOpen: () => !closed };
        return ok(stream);
      }

      let addon: Record<string, (...a: unknown[]) => unknown>;
      try { addon = sdlPush(); } catch (e) { return err({ code: "ENOENT", message: (e as Error).message }); }
      const ext = addon.open!(sampleRate, channels);
      const e = errOut(ext);
      if (e) return err({ code: e.code, message: e.error });

      const wasmMod = cb.native?.[`sz_audio_${cb.id}`] as { init(s: unknown): number; render(b: number, out: Float32Array, f: number): void; free(b: number): void } | undefined;
      let boxPtr = 0;
      if (wasmMod) {
        try { boxPtr = wasmMod.init(state); } catch (ex) { addon.close!(ext); throw ex; }
      }

      const frameBytes = channels * 4;
      const CHUNK = 512;
      const WATERMARK = 1536 * frameBytes;
      const f32 = new Float32Array(CHUNK * channels);
      const slice = wasmMod ? undefined : new Slice<number>(f32, 0, f32.length);
      let closed = false, trapped = false;
      const pump = (): void => {
        if (closed) return;
        let q = addon.queued!(ext) as number;
        while (q >= 0 && q < WATERMARK) {
          f32.fill(0);
          if (!trapped) {
            try {
              if (wasmMod) wasmMod.render(boxPtr, f32, CHUNK);
              else cb.fn(state, slice!, CHUNK);
            } catch (ex) {
              trapped = true;
              f32.fill(0);
              const t = rt.asTrap(ex);
              if (t) rt.noteIsolateTrap({ code: t.code, file: t.pos?.file ?? "", line: t.pos?.line ?? 0, col: t.pos?.col ?? 0 });
              else rt.noteIsolateTrap({ code: "T006" });
            }
          }
          addon.put!(ext, f32);
          q += CHUNK * frameBytes;
        }
      };
      pump();
      const timer = setInterval(pump, 5);
      timer.unref?.();

      const close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        activeClosers.delete(close);
        addon.close!(ext);
        if (wasmMod && boxPtr) { try { wasmMod.free(boxPtr); } finally { boxPtr = 0; } }
      };
      activeClosers.add(close);
      const stream: AudioStream = { sampleRate, channels, close, disposeAsync: close, isOpen: () => !closed };
      return ok(stream);
    },
  };
}

// Node Display host over SDL3 (loaded lazily at runtime via dlopen; zero build-time SDL3 dependency, Q279).
import { createSdlDisplay, type DisplayAddon, type Display } from "../../std/src/index.ts";
import { loadNative } from "./native.ts";

export const DISPLAY_SDL_C = `
#include <node_api.h>
#include <dlfcn.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdatomic.h>

#if defined(__BYTE_ORDER__) && __BYTE_ORDER__ == __ORDER_BIG_ENDIAN__
#define SZ_RGBA32 0x16462004u
#else
#define SZ_RGBA32 0x16762004u
#endif

typedef struct { float x, y, w, h; } sz_frect;
typedef struct { uint32_t type, res; uint64_t ts; uint32_t win, kb; int32_t scan; uint32_t key; uint16_t mod, raw; bool down, rep; } sz_ev_key;
typedef struct { uint32_t type, res; uint64_t ts; uint32_t win, which, state; float x, y, xrel, yrel; } sz_ev_mot;
typedef struct { uint32_t type, res; uint64_t ts; uint32_t win, which; uint8_t btn; bool down; uint8_t clicks, pad; float x, y; } sz_ev_btn;
typedef struct { uint32_t type, res; uint64_t ts; uint32_t win, which; float x, y; uint32_t dir; float mx, my; int32_t ix, iy; } sz_ev_whl;
typedef struct { uint32_t type, res; uint64_t ts; uint32_t win; } sz_ev_win;
typedef union { uint32_t type; sz_ev_win c; sz_ev_key k; sz_ev_mot m; sz_ev_btn b; sz_ev_whl w; uint8_t pad[128]; } sz_ev;

static struct {
  int tried, ok; const char *ec, *em; char em_buf[256]; void *lib;
  bool (*InitSubSystem)(uint32_t);
  void (*QuitSubSystem)(uint32_t);
  uint32_t (*WasInit)(uint32_t);
  void (*Quit)(void);
  bool (*CreateWindowAndRenderer)(const char *, int, int, uint64_t, void **, void **);
  uint32_t (*GetWindowID)(void *);
  bool (*SetRenderVSync)(void *, int);
  bool (*SetRenderDrawBlendMode)(void *, uint32_t);
  bool (*SetRenderDrawColor)(void *, uint8_t, uint8_t, uint8_t, uint8_t);
  bool (*RenderClear)(void *);
  bool (*RenderFillRect)(void *, const sz_frect *);
  bool (*RenderRect)(void *, const sz_frect *);
  bool (*RenderLine)(void *, float, float, float, float);
  bool (*RenderDebugText)(void *, float, float, const char *);
  bool (*RenderPresent)(void *);
  void *(*CreateTexture)(void *, uint32_t, int, int, int);
  bool (*SetTextureBlendMode)(void *, uint32_t);
  bool (*SetTextureScaleMode)(void *, int);
  bool (*UpdateTexture)(void *, const void *, const void *, int);
  bool (*RenderTexture)(void *, void *, const sz_frect *, const sz_frect *);
  void (*DestroyTexture)(void *);
  void (*DestroyRenderer)(void *);
  void (*DestroyWindow)(void *);
  bool (*PollEvent)(sz_ev *);
  const char *(*GetKeyName)(uint32_t);
  const char *(*GetError)(void);
} sdl;

static bool load_sdl(const char **ec, const char **em) {
  if (sdl.ok) return true;
  if (sdl.tried) { *ec = sdl.ec; *em = sdl.em; return false; }
  sdl.tried = 1;
  void *h = dlopen("libSDL3.so.0", RTLD_LAZY | RTLD_LOCAL);
  if (!h) h = dlopen("libSDL3.so", RTLD_LAZY | RTLD_LOCAL);
  if (!h) { const char *d = dlerror(); snprintf(sdl.em_buf, sizeof(sdl.em_buf), "%s", d ? d : "libSDL3.so.0 not found"); sdl.ec = "ENOENT"; sdl.em = sdl.em_buf; *ec = sdl.ec; *em = sdl.em; return false; }
  sdl.lib = h;
  #define SYM(n) if (!(sdl.n = dlsym(h, "SDL_" #n))) { sdl.ec = "EIO"; sdl.em = "missing symbol SDL_" #n; *ec = sdl.ec; *em = sdl.em; return false; }
  SYM(InitSubSystem) SYM(QuitSubSystem) SYM(WasInit) SYM(Quit)
  SYM(CreateWindowAndRenderer) SYM(GetWindowID) SYM(SetRenderDrawBlendMode) SYM(SetRenderDrawColor)
  SYM(RenderClear) SYM(RenderFillRect) SYM(RenderRect) SYM(RenderLine) SYM(RenderDebugText) SYM(RenderPresent)
  SYM(CreateTexture) SYM(SetTextureBlendMode) SYM(UpdateTexture) SYM(RenderTexture)
  SYM(DestroyTexture) SYM(DestroyRenderer) SYM(DestroyWindow) SYM(PollEvent) SYM(GetKeyName) SYM(GetError)
  #undef SYM
  sdl.SetRenderVSync = dlsym(h, "SDL_SetRenderVSync");
  sdl.SetTextureScaleMode = dlsym(h, "SDL_SetTextureScaleMode");
  sdl.ok = 1; return true;
}

typedef struct {
  void *win, *ren, *tex;
  uint32_t win_id;
  int tex_w, tex_h;
  _Atomic int closed;
} sz_surf;

static void quit_if_idle(void) { sdl.QuitSubSystem(0x20u); if (!sdl.WasInit(0)) sdl.Quit(); }
static void destroy_surf(sz_surf *s) {
  if (!atomic_exchange(&s->closed, 1)) {
    if (s->tex) { sdl.DestroyTexture(s->tex); s->tex = 0; }
    if (s->ren) { sdl.DestroyRenderer(s->ren); s->ren = 0; }
    if (s->win) { sdl.DestroyWindow(s->win); s->win = 0; }
    quit_if_idle();
  }
}
static void fin_surf(napi_env env, void *data, void *hint) {
  (void)env; (void)hint;
  sz_surf *s = (sz_surf *)data;
  destroy_surf(s);
  free(s);
}
static napi_value err_obj(napi_env env, const char *code, const char *msg) {
  napi_value o, v; napi_create_object(env, &o);
  napi_create_string_utf8(env, code ? code : "EIO", NAPI_AUTO_LENGTH, &v); napi_set_named_property(env, o, "code", v);
  napi_create_string_utf8(env, msg ? msg : "display error", NAPI_AUTO_LENGTH, &v); napi_set_named_property(env, o, "error", v);
  return o;
}
static sz_surf *get_surf(napi_env env, napi_value v) {
  void *p = 0;
  if (napi_get_value_external(env, v, &p) != napi_ok || !p) return 0;
  sz_surf *s = (sz_surf *)p;
  return atomic_load(&s->closed) || !s->ren ? 0 : s;
}
static void set_str(napi_env env, napi_value o, const char *k, const char *s) {
  napi_value v; napi_create_string_utf8(env, s ? s : "", NAPI_AUTO_LENGTH, &v); napi_set_named_property(env, o, k, v);
}
static void set_num(napi_env env, napi_value o, const char *k, double d) {
  napi_value v; napi_create_double(env, d, &v); napi_set_named_property(env, o, k, v);
}
static void set_u32(napi_env env, napi_value o, const char *k, uint32_t u) {
  napi_value v; napi_create_uint32(env, u, &v); napi_set_named_property(env, o, k, v);
}
static void set_bool(napi_env env, napi_value o, const char *k, bool b) {
  napi_value v; napi_get_boolean(env, b, &v); napi_set_named_property(env, o, k, v);
}
static uint32_t map_btn(uint8_t b) { return b == 1 ? 0 : b == 2 ? 1 : b == 3 ? 2 : (uint32_t)b; }
static uint32_t map_btns(uint32_t st) { return ((st & 1u) ? 1u : 0u) | ((st & 4u) ? 2u : 0u) | ((st & 2u) ? 4u : 0u) | (st & ~7u); }

static napi_value n_init(napi_env env, napi_callback_info info) { (void)env; (void)info; return 0; }
static napi_value n_open(napi_env env, napi_callback_info info) {
  size_t argc = 3; napi_value argv[3]; napi_get_cb_info(env, info, &argc, argv, 0, 0);
  size_t tlen = 0; napi_get_value_string_utf8(env, argv[0], 0, 0, &tlen);
  char *title = malloc(tlen + 1);
  if (!title) return err_obj(env, "ENOMEM", "out of memory");
  napi_get_value_string_utf8(env, argv[0], title, tlen + 1, &tlen);
  uint32_t w = 0, h = 0; napi_get_value_uint32(env, argv[1], &w); napi_get_value_uint32(env, argv[2], &h);
  const char *ec = 0, *em = 0;
  if (!load_sdl(&ec, &em)) { free(title); return err_obj(env, ec, em); }
  if (!sdl.InitSubSystem(0x20u)) { const char *m = sdl.GetError(); free(title); return err_obj(env, "EIO", m && *m ? m : "SDL_InitSubSystem failed"); }
  void *win = 0, *ren = 0;
  bool ok = sdl.CreateWindowAndRenderer(title, (int)w, (int)h, 0, &win, &ren);
  free(title);
  if (!ok || !win || !ren) { const char *m = sdl.GetError(); quit_if_idle(); return err_obj(env, "EIO", m && *m ? m : "SDL_CreateWindowAndRenderer failed"); }
  if (sdl.SetRenderVSync) (void)sdl.SetRenderVSync(ren, 1);
  sdl.SetRenderDrawBlendMode(ren, 1u);
  sz_surf *s = calloc(1, sizeof *s);
  s->win = win; s->ren = ren; s->win_id = sdl.GetWindowID(win);
  napi_value ext; napi_create_external(env, s, fin_surf, 0, &ext);
  return ext;
}
static napi_value n_clear(napi_env env, napi_callback_info info) {
  size_t argc = 5; napi_value argv[5]; napi_get_cb_info(env, info, &argc, argv, 0, 0);
  sz_surf *s = get_surf(env, argv[0]); if (!s) return 0;
  uint32_t r = 0, g = 0, b = 0, a = 0;
  napi_get_value_uint32(env, argv[1], &r); napi_get_value_uint32(env, argv[2], &g);
  napi_get_value_uint32(env, argv[3], &b); napi_get_value_uint32(env, argv[4], &a);
  sdl.SetRenderDrawBlendMode(s->ren, 0u);
  sdl.SetRenderDrawColor(s->ren, (uint8_t)r, (uint8_t)g, (uint8_t)b, (uint8_t)a);
  sdl.RenderClear(s->ren);
  sdl.SetRenderDrawBlendMode(s->ren, 1u);
  return 0;
}
static napi_value n_rect(napi_env env, napi_callback_info info, bool fill) {
  size_t argc = 9; napi_value argv[9]; napi_get_cb_info(env, info, &argc, argv, 0, 0);
  sz_surf *s = get_surf(env, argv[0]); if (!s) return 0;
  double x = 0, y = 0, w = 0, h = 0; uint32_t r = 0, g = 0, b = 0, a = 0;
  napi_get_value_double(env, argv[1], &x); napi_get_value_double(env, argv[2], &y);
  napi_get_value_double(env, argv[3], &w); napi_get_value_double(env, argv[4], &h);
  napi_get_value_uint32(env, argv[5], &r); napi_get_value_uint32(env, argv[6], &g);
  napi_get_value_uint32(env, argv[7], &b); napi_get_value_uint32(env, argv[8], &a);
  sz_frect rc = { (float)x, (float)y, (float)w, (float)h };
  sdl.SetRenderDrawColor(s->ren, (uint8_t)r, (uint8_t)g, (uint8_t)b, (uint8_t)a);
  if (fill) sdl.RenderFillRect(s->ren, &rc); else sdl.RenderRect(s->ren, &rc);
  return 0;
}
static napi_value n_fill_rect(napi_env env, napi_callback_info info) { return n_rect(env, info, true); }
static napi_value n_stroke_rect(napi_env env, napi_callback_info info) { return n_rect(env, info, false); }
static napi_value n_draw_line(napi_env env, napi_callback_info info) {
  size_t argc = 9; napi_value argv[9]; napi_get_cb_info(env, info, &argc, argv, 0, 0);
  sz_surf *s = get_surf(env, argv[0]); if (!s) return 0;
  double x1 = 0, y1 = 0, x2 = 0, y2 = 0; uint32_t r = 0, g = 0, b = 0, a = 0;
  napi_get_value_double(env, argv[1], &x1); napi_get_value_double(env, argv[2], &y1);
  napi_get_value_double(env, argv[3], &x2); napi_get_value_double(env, argv[4], &y2);
  napi_get_value_uint32(env, argv[5], &r); napi_get_value_uint32(env, argv[6], &g);
  napi_get_value_uint32(env, argv[7], &b); napi_get_value_uint32(env, argv[8], &a);
  sdl.SetRenderDrawColor(s->ren, (uint8_t)r, (uint8_t)g, (uint8_t)b, (uint8_t)a);
  sdl.RenderLine(s->ren, (float)x1, (float)y1, (float)x2, (float)y2);
  return 0;
}
static napi_value n_draw_text(napi_env env, napi_callback_info info) {
  size_t argc = 8; napi_value argv[8]; napi_get_cb_info(env, info, &argc, argv, 0, 0);
  sz_surf *s = get_surf(env, argv[0]); if (!s) return 0;
  double x = 0, y = 0; uint32_t r = 0, g = 0, b = 0, a = 0;
  napi_get_value_double(env, argv[1], &x); napi_get_value_double(env, argv[2], &y);
  size_t slen = 0; napi_get_value_string_utf8(env, argv[3], 0, 0, &slen);
  char *txt = malloc(slen + 1);
  if (!txt) return 0;
  napi_get_value_string_utf8(env, argv[3], txt, slen + 1, &slen);
  napi_get_value_uint32(env, argv[4], &r); napi_get_value_uint32(env, argv[5], &g);
  napi_get_value_uint32(env, argv[6], &b); napi_get_value_uint32(env, argv[7], &a);
  sdl.SetRenderDrawColor(s->ren, (uint8_t)r, (uint8_t)g, (uint8_t)b, (uint8_t)a);
  sdl.RenderDebugText(s->ren, (float)x, (float)y, txt);
  free(txt);
  return 0;
}
static napi_value n_blit(napi_env env, napi_callback_info info) {
  size_t argc = 8; napi_value argv[8]; napi_get_cb_info(env, info, &argc, argv, 0, 0);
  sz_surf *s = get_surf(env, argv[0]); if (!s) return 0;
  napi_typedarray_type tt; size_t len = 0, off = 0; void *data = 0; napi_value ab;
  if (napi_get_typedarray_info(env, argv[1], &tt, &len, &data, &ab, &off) != napi_ok || !data) return 0;
  uint32_t sw = 0, sh = 0; double dx = 0, dy = 0, dw = 0, dh = 0;
  napi_get_value_uint32(env, argv[2], &sw); napi_get_value_uint32(env, argv[3], &sh);
  napi_get_value_double(env, argv[4], &dx); napi_get_value_double(env, argv[5], &dy);
  napi_get_value_double(env, argv[6], &dw); napi_get_value_double(env, argv[7], &dh);
  if (!sw || !sh || len < (size_t)sw * (size_t)sh * 4) return 0;
  if (!s->tex || s->tex_w != (int)sw || s->tex_h != (int)sh) {
    if (s->tex) sdl.DestroyTexture(s->tex);
    s->tex = sdl.CreateTexture(s->ren, SZ_RGBA32, 1, (int)sw, (int)sh);
    s->tex_w = (int)sw; s->tex_h = (int)sh;
    if (!s->tex) return 0;
    sdl.SetTextureBlendMode(s->tex, 1u);
    if (sdl.SetTextureScaleMode) sdl.SetTextureScaleMode(s->tex, 0);
  }
  sdl.UpdateTexture(s->tex, 0, data, (int)(sw * 4));
  sz_frect dst = { (float)dx, (float)dy, (float)dw, (float)dh };
  sdl.RenderTexture(s->ren, s->tex, 0, &dst);
  return 0;
}
static napi_value n_present(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1]; napi_get_cb_info(env, info, &argc, argv, 0, 0);
  sz_surf *s = get_surf(env, argv[0]); if (s) sdl.RenderPresent(s->ren);
  return 0;
}
static napi_value n_poll(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1]; napi_get_cb_info(env, info, &argc, argv, 0, 0);
  napi_value arr; napi_create_array(env, &arr);
  sz_surf *s = get_surf(env, argv[0]); if (!s) return arr;
  uint32_t idx = 0; sz_ev ev;
  for (int n = 0; n < 256 && sdl.PollEvent(&ev); n++) {
    napi_value o = 0;
    if (ev.type == 0x100u || (ev.type == 0x210u && ev.c.win == s->win_id)) {
      napi_create_object(env, &o); set_str(env, o, "kind", "close");
    } else if (ev.type == 0x400u && ev.m.win == s->win_id) {
      napi_create_object(env, &o); set_str(env, o, "kind", "pointerMove");
      set_num(env, o, "x", ev.m.x); set_num(env, o, "y", ev.m.y); set_u32(env, o, "buttons", map_btns(ev.m.state));
    } else if ((ev.type == 0x401u || ev.type == 0x402u) && ev.b.win == s->win_id) {
      napi_create_object(env, &o); set_str(env, o, "kind", ev.type == 0x401u ? "pointerDown" : "pointerUp");
      set_num(env, o, "x", ev.b.x); set_num(env, o, "y", ev.b.y); set_u32(env, o, "button", map_btn(ev.b.btn));
    } else if (ev.type == 0x403u && ev.w.win == s->win_id) {
      double sign = ev.w.dir == 1u ? -1.0 : 1.0;
      napi_create_object(env, &o); set_str(env, o, "kind", "wheel");
      set_num(env, o, "x", ev.w.mx); set_num(env, o, "y", ev.w.my);
      set_num(env, o, "dx", ev.w.x * sign); set_num(env, o, "dy", -ev.w.y * sign);
    } else if ((ev.type == 0x300u || ev.type == 0x301u) && ev.k.win == s->win_id) {
      bool down = ev.type == 0x300u;
      napi_create_object(env, &o); set_str(env, o, "kind", down ? "keyDown" : "keyUp");
      set_str(env, o, "key", sdl.GetKeyName(ev.k.key));
      if (down) set_bool(env, o, "repeat", ev.k.rep);
      set_bool(env, o, "shift", (ev.k.mod & 0x0003u) != 0);
      set_bool(env, o, "ctrl", (ev.k.mod & 0x00c0u) != 0);
      set_bool(env, o, "alt", (ev.k.mod & 0x0300u) != 0);
    }
    if (o) napi_set_element(env, arr, idx++, o);
  }
  return arr;
}
static napi_value n_close(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1]; napi_get_cb_info(env, info, &argc, argv, 0, 0);
  void *p = 0; if (napi_get_value_external(env, argv[0], &p) == napi_ok && p) destroy_surf((sz_surf *)p);
  return 0;
}
NAPI_MODULE_INIT() {
  napi_value f;
  #define EXP(n, fn) napi_create_function(env, n, NAPI_AUTO_LENGTH, fn, 0, &f); napi_set_named_property(env, exports, n, f)
  EXP("init", n_init); EXP("open", n_open); EXP("clear", n_clear); EXP("fillRect", n_fill_rect);
  EXP("strokeRect", n_stroke_rect); EXP("drawLine", n_draw_line); EXP("drawText", n_draw_text);
  EXP("blit", n_blit); EXP("present", n_present); EXP("poll", n_poll); EXP("close", n_close);
  return exports;
}
`;

let displayAddon: DisplayAddon | undefined;
/** Creates the Node host `Display` implementation using SDL3. */
export function createNodeDisplay(): Display {
  return createSdlDisplay(() => (displayAddon ??= loadNative(DISPLAY_SDL_C, {}) as unknown as DisplayAddon));
}

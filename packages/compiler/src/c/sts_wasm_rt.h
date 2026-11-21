// Freestanding C11 runtime for the Wasm backend (Q280, Q281). Zero libc / WASI dependency.
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

#define STS_IMP(name) __attribute__((import_module("env"), import_name(#name)))
#define STS_EXP(name) __attribute__((export_name(#name)))

#define NAN (__builtin_nanf(""))
#define INFINITY (__builtin_inff())
#define isnan(x) __builtin_isnan(x)
#define isinf(x) __builtin_isinf(x)
#define signbit(x) __builtin_signbit(x)
#define fabs(x) __builtin_fabs(x)
#define sqrt(x) __builtin_sqrt(x)
#define floor(x) __builtin_floor(x)
#define ceil(x) __builtin_ceil(x)
#define trunc(x) __builtin_trunc(x)

#if defined(__clang__)
#define STS_NO_BUILTIN __attribute__((no_builtin("memcpy", "memmove", "memset")))
#else
#define STS_NO_BUILTIN
#endif

// Provide freestanding memory ops in case clang lowers struct copies or loops to calls.
STS_NO_BUILTIN void *memcpy(void *dst, const void *src, size_t n) {
  uint8_t *d = (uint8_t *)dst; const uint8_t *s = (const uint8_t *)src;
  for (size_t i = 0; i < n; i++) d[i] = s[i];
  return dst;
}
STS_NO_BUILTIN void *memmove(void *dst, const void *src, size_t n) {
  uint8_t *d = (uint8_t *)dst; const uint8_t *s = (const uint8_t *)src;
  if (d < s) for (size_t i = 0; i < n; i++) d[i] = s[i];
  else if (d > s) for (size_t i = n; i > 0; i--) d[i - 1] = s[i - 1];
  return dst;
}
STS_NO_BUILTIN void *memset(void *dst, int c, size_t n) {
  uint8_t *d = (uint8_t *)dst; uint8_t v = (uint8_t)c;
  for (size_t i = 0; i < n; i++) d[i] = v;
  return dst;
}

typedef int32_t sts_val;
typedef struct { sts_val obj; void *data; uint32_t len, cap, esize; } sts_vec;
typedef struct { void *data; uint32_t len; } sts_slice;
typedef struct { uint32_t pool, gen, idx; } sts_handle;
typedef struct { bool some; } sts_null;

STS_IMP(sts_trap) _Noreturn void sts_js_trap(int32_t code, int32_t pos);
STS_IMP(sts_fail) _Noreturn void sts_js_fail(const char *msg);
STS_IMP(sts_fmod) double sts_fmod(double a, double b);

STS_IMP(sts_get) sts_val sts_get(sts_val o, const char *k);
STS_IMP(sts_set) void sts_set(sts_val o, const char *k, sts_val v);
STS_IMP(sts_mkobj) sts_val sts_mkobj(void);
STS_IMP(sts_num) double sts_num(sts_val v);
STS_IMP(sts_i64) int64_t sts_i64(sts_val v);
STS_IMP(sts_u64) uint64_t sts_u64(sts_val v);
STS_IMP(sts_bool) int32_t sts_js_bool(sts_val v);
STS_IMP(sts_mknum) sts_val sts_mknum(double d);
STS_IMP(sts_mki64) sts_val sts_mki64(int64_t x);
STS_IMP(sts_mku64) sts_val sts_mku64(uint64_t x);
STS_IMP(sts_mkbool) sts_val sts_js_mkbool(int32_t b);
STS_IMP(sts_mknull) sts_val sts_mknull(void);
STS_IMP(sts_isnull) int32_t sts_js_isnull(sts_val v);
STS_IMP(sts_mklit) sts_val sts_mklit(int32_t k);
STS_IMP(sts_lit_in) int32_t sts_lit_in(sts_val v);
STS_IMP(sts_callm) sts_val sts_callm(sts_val o, const char *m, uint32_t n, sts_val *a);

STS_IMP(sts_reg_wb) void sts_reg_wb(int32_t id, void *fr);
STS_IMP(sts_clear_wb) void sts_clear_wb(void);

STS_IMP(sts_vec_in) void sts_js_vec_in(sts_val o, uint32_t es, const char *desc, uint32_t *out3);
STS_IMP(sts_vec_create) sts_val sts_js_vec_create(sts_val alloc, uint32_t cap, const char *elem, int32_t pos);
STS_IMP(sts_vec_grow) void sts_js_vec_grow(sts_val o, void *old_data, uint32_t cap, uint32_t len, uint32_t esize, int32_t pos, uint32_t *out2);
STS_IMP(sts_vec_sync) void sts_js_vec_sync(sts_val o, uint32_t len);
STS_IMP(sts_slice_in) void sts_js_slice_in(sts_val o, uint32_t es, const char *desc, uint32_t *out2);

STS_IMP(sts_pool_in) void sts_js_pool_in(sts_val o, uint32_t es, const char *desc, uint32_t *u7, double *d2);
STS_IMP(sts_pool_create) sts_val sts_js_pool_create(sts_val alloc, uint32_t cap, const char *elem, int32_t pos);
STS_IMP(sts_pool_sync) void sts_js_pool_sync(sts_val o, uint32_t len, double freeHead, double nextFresh);

STS_IMP(sts_arena_in) void sts_js_arena_in(sts_val o, uint32_t *u4);
STS_IMP(sts_arena_create) sts_val sts_js_arena_create(sts_val alloc, uint32_t bytes, int32_t pos);
STS_IMP(sts_arena_note) void sts_js_arena_note(sts_val o, uint32_t off, const char *desc);
STS_IMP(sts_arena_reset_notes) void sts_js_arena_reset_notes(sts_val o);
STS_IMP(sts_arena_sync) void sts_js_arena_sync(sts_val o, uint32_t used, uint32_t gen);

STS_IMP(sts_ring_in) uint32_t sts_js_ring_in(sts_val o, const char *desc);
STS_IMP(sts_ring_create) sts_val sts_js_ring_create(sts_val alloc, uint32_t cap, const char *elem, int32_t pos);
STS_IMP(sts_ring_push) int32_t sts_wasm_ring_push(sts_val o, const void *src, uint32_t esize);
STS_IMP(sts_ring_pop) int32_t sts_wasm_ring_pop(sts_val o, void *dst, uint32_t esize);

static bool sts_bool(sts_val v) { return sts_js_bool(v) != 0; }
static sts_val sts_mkbool(bool b) { return sts_js_mkbool(b ? 1 : 0); }
static bool sts_isnull(sts_val v) { return sts_js_isnull(v) != 0; }

static void sts_defer_unwind(void);
static int sts_unwinding = 0;
__attribute__((cold)) _Noreturn static void sts_trap(int code, int pos) { sts_defer_unwind(); sts_unwinding = 0; sts_js_trap(code, pos); }
__attribute__((cold)) _Noreturn static void sts_fail(const char *msg) { sts_defer_unwind(); sts_unwinding = 0; sts_js_fail(msg); }

static int32_t sts_depth = 0;
STS_EXP(sts_get_depth) int32_t sts_get_depth(void) { return sts_depth; }
STS_EXP(sts_set_depth) void sts_set_depth(int32_t d) { sts_depth = d; }
// Linked with `-Wl,--stack-first -Wl,-z,stack-size=1048576`: guard below 64 KiB catches frame overflow before SP hits 0.
static inline bool sts_stack_low(void) { volatile uint8_t b; return (uintptr_t)&b < 65536u; }
#define STS_STACK_LOW() sts_stack_low()

// Linear-memory coalescing heap allocator (16-byte aligned headers and payloads).
extern uint8_t __heap_base;
static _Alignas(16) uint8_t sts_empty[16];
STS_EXP(sts_empty_ptr) void *sts_empty_ptr(void) { return sts_empty; }

typedef struct sts_blk {
  uint32_t size;
  uint32_t free;
  struct sts_blk *prev;
  struct sts_blk *next;
} sts_blk;
_Static_assert(sizeof(sts_blk) == 16, "sts_blk must be 16 bytes");

static uint8_t *sts_heap_cur = 0;
static sts_blk *sts_heap_head = 0;
static sts_blk *sts_heap_tail = 0;

static void sts_heap_init(void) {
  if (sts_heap_cur) return;
  uintptr_t b = ((uintptr_t)&__heap_base + 15u) & ~(uintptr_t)15u;
  size_t have = __builtin_wasm_memory_size(0) * 65536u;
  if (b > have) {
    size_t need = (b - have + 65535u) >> 16;
    if (__builtin_wasm_memory_grow(0, need) == (size_t)-1) return;
  }
  sts_heap_cur = (uint8_t *)b;
}

static void *sts_malloc(size_t n) {
  sts_heap_init();
  if (!sts_heap_cur) return NULL;
  if (n > (size_t)UINT32_MAX - 16u) return NULL;
  uint32_t req = n == 0 ? 16u : (uint32_t)((n + 15u) & ~(size_t)15u);
  for (sts_blk *b = sts_heap_head; b; b = b->next) {
    if (b->free && b->size >= req) {
      if (b->size >= req + 32u) {
        sts_blk *rem = (sts_blk *)((uint8_t *)(b + 1) + req);
        rem->size = b->size - req - 16u;
        rem->free = 1;
        rem->prev = b;
        rem->next = b->next;
        if (b->next) b->next->prev = rem; else sts_heap_tail = rem;
        b->next = rem;
        b->size = req;
      }
      b->free = 0;
      return b + 1;
    }
  }
  uint64_t total = (uint64_t)(uintptr_t)sts_heap_cur + 16ull + req;
  if (total > (uint64_t)UINT32_MAX) return NULL;
  size_t have = __builtin_wasm_memory_size(0) * 65536u;
  if (total > have) {
    uint64_t need = ((total - have) + 65535ull) >> 16;
    if (need > (uint64_t)SIZE_MAX || __builtin_wasm_memory_grow(0, (size_t)need) == (size_t)-1) return NULL;
  }
  sts_blk *b = (sts_blk *)sts_heap_cur;
  sts_heap_cur += 16u + req;
  b->size = req;
  b->free = 0;
  b->prev = sts_heap_tail;
  b->next = NULL;
  if (sts_heap_tail) sts_heap_tail->next = b; else sts_heap_head = b;
  sts_heap_tail = b;
  return b + 1;
}

static void *sts_calloc(size_t count, size_t size) {
  if (count && size > (size_t)UINT32_MAX / count) return NULL;
  size_t tot = count * size;
  void *p = sts_malloc(tot);
  if (p) memset(p, 0, tot);
  return p;
}

static void sts_free(void *p) {
  if (!p) return;
  sts_blk *b = ((sts_blk *)p) - 1;
  b->free = 1;
  while (b->next && b->next->free) {
    sts_blk *nx = b->next;
    b->size += 16u + nx->size;
    b->next = nx->next;
    if (b->next) b->next->prev = b; else sts_heap_tail = b;
  }
  while (b->prev && b->prev->free) {
    sts_blk *pv = b->prev;
    pv->size += 16u + b->size;
    pv->next = b->next;
    if (pv->next) pv->next->prev = pv; else sts_heap_tail = pv;
    b = pv;
  }
  if (b == sts_heap_tail) {
    sts_heap_cur = (uint8_t *)b;
    sts_heap_tail = b->prev;
    if (sts_heap_tail) sts_heap_tail->next = NULL; else sts_heap_head = NULL;
  }
}

static void *sts_realloc(void *p, size_t n) {
  if (!p) return sts_malloc(n);
  sts_blk *b = ((sts_blk *)p) - 1;
  if (b->size >= n) return p;
  void *q = sts_malloc(n);
  if (!q) return NULL;
  memcpy(q, p, b->size < n ? b->size : n);
  sts_free(p);
  return q;
}

STS_EXP(sts_alloc) void *sts_wasm_alloc(uint32_t n) { return sts_malloc(n); }
STS_EXP(sts_dealloc) void sts_wasm_dealloc(void *p) { sts_free(p); }

#define malloc sts_malloc
#define calloc sts_calloc
#define realloc sts_realloc
#define free sts_free

typedef struct sts_defer { void (*fn)(void *); void *data; struct sts_defer *prev; } sts_defer;
static sts_defer *sts_defer_head, *sts_defer_base;
static void sts_defer_push(sts_defer *node, void (*fn)(void *), void *data) {
  node->fn = fn; node->data = data; node->prev = sts_defer_head;
  sts_defer_head = node;
}
static void sts_defer_pop_run(sts_defer *mark) {
  while (sts_defer_head && sts_defer_head != mark) {
    sts_defer *d = sts_defer_head;
    sts_defer_head = d->prev;
    if (d->fn) d->fn(d->data);
  }
}
static void sts_defer_unwind(void) {
  if (sts_unwinding) return;
  sts_unwinding = 1;
  sts_defer_pop_run(sts_defer_base);
  sts_unwinding = 0;
}
STS_EXP(sts_defer_enter) uint32_t sts_defer_enter(void) {
  uint32_t prev = (uint32_t)(uintptr_t)sts_defer_base;
  sts_defer_base = sts_defer_head;
  return prev;
}
STS_EXP(sts_defer_leave) void sts_defer_leave(uint32_t prev) {
  sts_defer *base = sts_defer_base;
  sts_defer_base = (sts_defer *)(uintptr_t)prev;
  if (!sts_unwinding && sts_defer_head != base) {
    sts_unwinding = 1;
    sts_defer_pop_run(base);
    sts_unwinding = 0;
  }
  if (sts_defer_head != base) sts_defer_head = base;
}

// Vec handles live until the boundary call returns; the list slice [v0..n) is synced in finally.
static sts_vec **sts_vecs; static size_t sts_nvecs, sts_capvecs;
static sts_vec *sts_vec_new(void) {
  if (sts_nvecs == sts_capvecs) {
    size_t c_ = sts_capvecs ? sts_capvecs * 2 : 16;
    void *p_ = realloc(sts_vecs, c_ * sizeof *sts_vecs);
    if (!p_) sts_fail("out of memory");
    sts_vecs = p_; sts_capvecs = c_;
  }
  sts_vec *v = calloc(1, sizeof *v);
  if (!v) sts_fail("out of memory");
  return sts_vecs[sts_nvecs++] = v;
}
static sts_vec *sts_vec_in(sts_val o, uint32_t es, const char *desc) {
  sts_vec *v = sts_vec_new(); v->obj = o; v->esize = es;
  uint32_t out[3];
  sts_js_vec_in(o, es, desc, out);
  v->data = (void *)(uintptr_t)out[0];
  v->len = out[1];
  v->cap = out[2];
  return v;
}
static sts_vec *sts_vec_create(sts_val alloc, uint32_t cap, const char *elem, uint32_t es, int pos) {
  sts_val r = sts_js_vec_create(alloc, cap, elem, pos);
  return sts_vec_in(r, es, elem);
}
static void sts_vec_grow(sts_vec *v, int pos) {
  if (v->len == UINT32_MAX) sts_trap(6, pos);
  uint64_t c = (uint64_t)v->len * 2;
  uint32_t cap = c > UINT32_MAX ? UINT32_MAX : c < 4 ? 4 : (uint32_t)c;
  uint32_t out[2];
  sts_js_vec_grow(v->obj, v->data, cap, v->len, v->esize, pos, out);
  v->data = (void *)(uintptr_t)out[0];
  v->cap = out[1];
}

// Pool handles live until the boundary call returns, like Vec handles.
typedef struct { sts_val obj; void *data; uint32_t len, cap, esize; uint32_t *gens; uint8_t *occ; int32_t *nextFree; int64_t freeHead, nextFresh; uint32_t id; } sts_pool;
static sts_pool **sts_pools; static size_t sts_npools, sts_cappools;
static sts_pool *sts_pool_new(void) {
  if (sts_npools == sts_cappools) {
    size_t c_ = sts_cappools ? sts_cappools * 2 : 16;
    void *p_ = realloc(sts_pools, c_ * sizeof *sts_pools);
    if (!p_) sts_fail("out of memory");
    sts_pools = p_; sts_cappools = c_;
  }
  sts_pool *p = calloc(1, sizeof *p);
  if (!p) sts_fail("out of memory");
  return sts_pools[sts_npools++] = p;
}
static sts_pool *sts_pool_in(sts_val o, uint32_t es, const char *desc) {
  sts_pool *p = sts_pool_new(); p->obj = o; p->esize = es;
  uint32_t u[7]; double d[2];
  sts_js_pool_in(o, es, desc, u, d);
  p->data = (void *)(uintptr_t)u[0];
  p->gens = (uint32_t *)(uintptr_t)u[1];
  p->occ = (uint8_t *)(uintptr_t)u[2];
  p->nextFree = (int32_t *)(uintptr_t)u[3];
  p->len = u[4]; p->cap = u[5]; p->id = u[6];
  p->freeHead = (int64_t)d[0]; p->nextFresh = (int64_t)d[1];
  return p;
}
static sts_pool *sts_pool_create(sts_val alloc, uint32_t cap, const char *elem, uint32_t es, int pos) {
  sts_val r = sts_js_pool_create(alloc, cap, elem, pos);
  return sts_pool_in(r, es, elem);
}
static bool sts_pool_valid(sts_pool *p, sts_handle h) { return h.pool == p->id && h.idx < p->cap && p->occ[h.idx] && p->gens[h.idx] == h.gen; }
static sts_handle sts_hdl_in(sts_val o) {
  sts_handle h;
  h.pool = (uint32_t)sts_num(sts_get(o, "pool"));
  h.gen = (uint32_t)sts_num(sts_get(o, "gen"));
  h.idx = (uint32_t)sts_num(sts_get(o, "idx"));
  return h;
}
static sts_val sts_hdl_out(sts_handle h) {
  sts_val o = sts_mkobj();
  sts_set(o, "pool", sts_mknum((double)h.pool));
  sts_set(o, "gen", sts_mknum((double)h.gen));
  sts_set(o, "idx", sts_mknum((double)h.idx));
  return o;
}
static inline bool sts_hdl_eq(sts_handle a, sts_handle b) { return a.pool == b.pool && a.gen == b.gen && a.idx == b.idx; }

typedef struct { uint32_t arena, gen, off, len; } sts_abuf;
static sts_abuf sts_abuf_in(sts_val o) {
  sts_abuf b;
  b.arena = (uint32_t)sts_num(sts_get(o, "arena"));
  b.gen = (uint32_t)sts_num(sts_get(o, "gen"));
  b.off = (uint32_t)sts_num(sts_get(o, "off"));
  b.len = (uint32_t)sts_num(sts_get(o, "length"));
  return b;
}
static sts_val sts_abuf_out(sts_abuf b) {
  sts_val o = sts_mkobj();
  sts_set(o, "arena", sts_mknum((double)b.arena));
  sts_set(o, "gen", sts_mknum((double)b.gen));
  sts_set(o, "off", sts_mknum((double)b.off));
  sts_set(o, "length", sts_mknum((double)b.len));
  return o;
}

// Arena handles live until the boundary call returns, like Pool handles.
typedef struct { sts_val obj; void *data; uint32_t cap, used, gen, id; } sts_arena;
static sts_arena **sts_arenas; static size_t sts_narenas, sts_caparenas;
static sts_arena *sts_arena_new(void) {
  if (sts_narenas == sts_caparenas) {
    size_t c_ = sts_caparenas ? sts_caparenas * 2 : 16;
    void *p_ = realloc(sts_arenas, c_ * sizeof *sts_arenas);
    if (!p_) sts_fail("out of memory");
    sts_arenas = p_; sts_caparenas = c_;
  }
  sts_arena *a = calloc(1, sizeof *a);
  if (!a) sts_fail("out of memory");
  return sts_arenas[sts_narenas++] = a;
}
static sts_arena *sts_arena_in(sts_val o) {
  sts_arena *a = sts_arena_new(); a->obj = o;
  uint32_t u[4];
  sts_js_arena_in(o, u);
  a->data = (void *)(uintptr_t)u[0];
  a->cap = u[1]; a->used = u[2]; a->gen = u[3];
  a->id = (uint32_t)sts_num(sts_get(o, "id"));
  return a;
}
static sts_arena *sts_arena_create(sts_val alloc, uint32_t bytes, int pos) {
  sts_val r = sts_js_arena_create(alloc, bytes, pos);
  return sts_arena_in(r);
}
static void sts_vec_free_detached(sts_vec *v) { if (v) { free(v->data); free(v); } }
static sts_vec *sts_vec_detach(sts_vec *v) {
  sts_vec *d = calloc(1, sizeof *d); if (!d) sts_fail("out of memory");
  d->obj = 0; d->len = v->len; d->cap = v->len; d->esize = v->esize;
  size_t n = (size_t)v->len * v->esize;
  d->data = malloc(n > 0 ? n : 1);
  if (!d->data) { free(d); sts_fail("out of memory"); }
  if (n > 0) memcpy(d->data, v->data, n);
  return d;
}
static void sts_pool_free_detached(sts_pool *p) { if (p) { free(p->data); free(p->gens); free(p->occ); free(p->nextFree); free(p); } }
static sts_pool *sts_pool_detach(sts_pool *p) {
  sts_pool *d = calloc(1, sizeof *d); if (!d) sts_fail("out of memory");
  d->obj = 0; d->len = p->len; d->cap = p->cap; d->esize = p->esize;
  d->freeHead = p->freeHead; d->nextFresh = p->nextFresh; d->id = p->id;
  if (p->cap > 0) {
    size_t db = (size_t)p->cap * p->esize;
    d->data = malloc(db > 0 ? db : 1);
    d->gens = malloc((size_t)p->cap * sizeof(uint32_t));
    d->occ = malloc((size_t)p->cap);
    d->nextFree = malloc((size_t)p->cap * sizeof(int32_t));
    if (!d->data || !d->gens || !d->occ || !d->nextFree) { sts_pool_free_detached(d); sts_fail("out of memory"); }
    if (db > 0) memcpy(d->data, p->data, db);
    memcpy(d->gens, p->gens, (size_t)p->cap * sizeof(uint32_t));
    memcpy(d->occ, p->occ, (size_t)p->cap);
    memcpy(d->nextFree, p->nextFree, (size_t)p->cap * sizeof(int32_t));
  }
  return d;
}
static void sts_arena_free_detached(sts_arena *a) { if (a) { free(a->data); free(a); } }
static sts_arena *sts_arena_detach(sts_arena *a) {
  sts_arena *d = calloc(1, sizeof *d); if (!d) sts_fail("out of memory");
  d->obj = 0; d->cap = a->cap; d->used = a->used; d->gen = a->gen; d->id = a->id;
  d->data = malloc(a->cap > 0 ? a->cap : 1);
  if (!d->data) { free(d); sts_fail("out of memory"); }
  if (a->used > 0) memcpy(d->data, a->data, a->used);
  return d;
}
static void sts_arena_note(sts_arena *a, uint32_t off, const char *desc) { if (!a->obj) return; sts_js_arena_note(a->obj, off, desc); }
static void sts_arena_reset_notes(sts_arena *a) { if (!a->obj) return; sts_js_arena_reset_notes(a->obj); }
static sts_slice sts_arena_view(sts_arena *a, sts_abuf b, int pos) {
  if (b.arena != a->id || b.gen != a->gen) sts_trap(12, pos);
  return (sts_slice){ (char *)a->data + b.off, b.len };
}

STS_EXP(sts_nvecs_get) uint32_t sts_nvecs_get(void) { return (uint32_t)sts_nvecs; }
STS_EXP(sts_npools_get) uint32_t sts_npools_get(void) { return (uint32_t)sts_npools; }
STS_EXP(sts_narenas_get) uint32_t sts_narenas_get(void) { return (uint32_t)sts_narenas; }
STS_EXP(sts_sync_frame) void sts_sync_frame(uint32_t v0, uint32_t p0, uint32_t a0) {
  for (size_t i = v0; i < sts_nvecs; i++) { sts_js_vec_sync(sts_vecs[i]->obj, sts_vecs[i]->len); free(sts_vecs[i]); }
  sts_nvecs = v0;
  for (size_t i = p0; i < sts_npools; i++) { sts_pool *p = sts_pools[i]; sts_js_pool_sync(p->obj, p->len, (double)p->freeHead, (double)p->nextFresh); free(p); }
  sts_npools = p0;
  for (size_t i = a0; i < sts_narenas; i++) { sts_arena *a = sts_arenas[i]; sts_js_arena_sync(a->obj, a->used, a->gen); free(a); }
  sts_narenas = a0;
}

typedef struct { sts_val obj; uint32_t cap, esize; } sts_ring;
static sts_ring sts_ring_in(sts_val o, uint32_t es, const char *desc) {
  sts_ring r; r.obj = o; r.esize = es; r.cap = sts_js_ring_in(o, desc); return r;
}
static sts_val sts_ring_create(sts_val alloc, uint32_t cap, const char *elem, int pos) {
  if (cap == 0 || cap > 0x80000000u || (cap & (cap - 1)) != 0) sts_trap(14, pos);
  return sts_js_ring_create(alloc, cap, elem, pos);
}

static sts_slice sts_vslice(sts_vec *v) { return (sts_slice){ v->data, v->len }; }
static sts_slice sts_slice_in(sts_val o, uint32_t es, const char *desc) {
  uint32_t out[2];
  sts_js_slice_in(o, es, desc, out);
  return (sts_slice){ (void *)(uintptr_t)out[0], out[1] };
}

typedef float __attribute__((may_alias)) sts_ma_float; typedef double __attribute__((may_alias)) sts_ma_double;
typedef int8_t __attribute__((may_alias)) sts_ma_int8_t; typedef uint8_t __attribute__((may_alias)) sts_ma_uint8_t;
typedef int16_t __attribute__((may_alias)) sts_ma_int16_t; typedef uint16_t __attribute__((may_alias)) sts_ma_uint16_t;
typedef int32_t __attribute__((may_alias)) sts_ma_int32_t; typedef uint32_t __attribute__((may_alias)) sts_ma_uint32_t;
typedef int64_t __attribute__((may_alias)) sts_ma_int64_t; typedef uint64_t __attribute__((may_alias)) sts_ma_uint64_t;
#define STS_LD(T, p) (*(const sts_ma_##T *)(p))
#define STS_ST(p, T, v) (*(sts_ma_##T *)(p) = (v))
static uint32_t sts_lidx(const int32_t *tbl, uint32_t n, int32_t id) { for (uint32_t i = 0; i < n; i++) if (tbl[i] == id) return i; sts_fail("bad literal"); return 0; }
static void sts_chk(uint32_t i, uint32_t len, int pos) { if (__builtin_expect(i >= len, 0)) sts_trap(2, pos); }
static bool sts_ovl(sts_slice a, sts_slice b, size_t az, size_t bz) {
  uintptr_t a0 = (uintptr_t)a.data, b0 = (uintptr_t)b.data;
  uintptr_t a1 = a0 + (size_t)a.len * az, b1 = b0 + (size_t)b.len * bz;
  return (a0 > b0 ? a0 : b0) < (a1 < b1 ? a1 : b1);
}
static sts_slice sts_sub(sts_slice s, uint32_t a, uint32_t b, size_t es, int pos) {
  if (!(a <= b && b <= s.len)) sts_trap(2, pos);
  return (sts_slice){ (char *)s.data + (size_t)a * es, b - a };
}

#define STS_AOP(op, T, a, b, pos) ({ T r_; if (__builtin_expect(__builtin_##op##_overflow((a), (b), &r_), 0)) sts_trap(1, (pos)); r_; })
// Split 64-bit multiplies into 32-bit half-products to avoid compiler-rt `__multi3` under freestanding wasm32.
static uint64_t sts_mulu64(uint64_t a, uint64_t b, int pos) {
  uint64_t ah = a >> 32, al = (uint32_t)a, bh = b >> 32, bl = (uint32_t)b;
  if (ah && bh) sts_trap(1, pos);
  uint64_t p0 = al * bl, p1 = ah * bl, p2 = al * bh;
  if ((p1 >> 32) || (p2 >> 32)) sts_trap(1, pos);
  uint64_t mid = (p0 >> 32) + (uint32_t)p1 + (uint32_t)p2;
  if (mid >> 32) sts_trap(1, pos);
  return (mid << 32) | (uint32_t)p0;
}
static int64_t sts_muli64(int64_t a, int64_t b, int pos) {
  if (a == 0 || b == 0) return 0;
  bool neg = (a < 0) != (b < 0);
  uint64_t ua = a < 0 ? (uint64_t)0 - (uint64_t)a : (uint64_t)a;
  uint64_t ub = b < 0 ? (uint64_t)0 - (uint64_t)b : (uint64_t)b;
  uint64_t ah = ua >> 32, al = (uint32_t)ua, bh = ub >> 32, bl = (uint32_t)ub;
  if (ah && bh) sts_trap(1, pos);
  uint64_t p0 = al * bl, p1 = ah * bl, p2 = al * bh;
  if ((p1 >> 32) || (p2 >> 32)) sts_trap(1, pos);
  uint64_t mid = (p0 >> 32) + (uint32_t)p1 + (uint32_t)p2;
  if (mid >> 32) sts_trap(1, pos);
  uint64_t ur = (mid << 32) | (uint32_t)p0;
  uint64_t lim = neg ? ((uint64_t)INT64_MAX + 1ULL) : (uint64_t)INT64_MAX;
  if (ur > lim) sts_trap(1, pos);
  return neg ? (int64_t)((uint64_t)0 - ur) : (int64_t)ur;
}
#define STS_MULI64 sts_muli64
#define STS_MULU64 sts_mulu64
static int64_t sts_rng(int64_t r, int64_t lo, int64_t hi, int pos) { if (__builtin_expect(r < lo || r > hi, 0)) sts_trap(1, pos); return r; }
#define STS_DIV(T, a, b, pos) ({ T a_ = (a), b_ = (b); if (__builtin_expect(b_ == 0, 0)) sts_trap(7, (pos)); ((T)-1 < 0 && b_ == (T)-1) ? STS_AOP(sub, T, (T)0, a_, (pos)) : (T)(a_ / b_); })
#define STS_REM(T, a, b, pos) ({ T a_ = (a), b_ = (b); if (__builtin_expect(b_ == 0, 0)) sts_trap(7, (pos)); ((T)-1 < 0 && b_ == (T)-1) ? (T)0 : (T)(a_ % b_); })
static int64_t sts_wrap(int64_t r, int64_t lo, int64_t hi) { int64_t m = hi - lo + 1; return ((r - lo) % m + m) % m + lo; }
static int64_t sts_wmul32(int64_t a, int64_t b, int64_t lo, int64_t hi) { return sts_wrap((int64_t)(uint32_t)((uint32_t)a * (uint32_t)b), lo, hi); }
static uint32_t sts_amt(int64_t n, int pos) { if (n < 0 || n > 31) sts_trap(9, pos); return (uint32_t)n; }
static uint32_t sts_amt64(uint64_t n, int pos) { if (n > 63ULL) sts_trap(9, pos); return (uint32_t)n; }
static int64_t sts_cvt(double x, int64_t lo, int64_t hi, int pos) { if (!(x >= (double)lo && x <= (double)hi) || x != trunc(x)) sts_trap(3, pos); return (int64_t)x; }
static int64_t sts_cvt_i64(double x, int pos) { if (!(x >= -9223372036854775808.0 && x < 9223372036854775808.0) || x != trunc(x)) sts_trap(3, pos); return (int64_t)x; }
static uint64_t sts_cvt_u64(double x, int pos) { if (!(x >= 0.0 && x < 18446744073709551616.0) || x != trunc(x)) sts_trap(3, pos); return (uint64_t)x; }
static int64_t sts_cvti(int64_t x, int64_t lo, int64_t hi, int pos) { if (x < lo || x > hi) sts_trap(3, pos); return x; }
static int64_t sts_cvtu(uint64_t x, uint64_t hi, int pos) { if (x > hi) sts_trap(3, pos); return (int64_t)x; }
static uint64_t sts_cvti_u64(int64_t x, int pos) { if (x < 0) sts_trap(3, pos); return (uint64_t)x; }

static double sts_round(double x) {
  if (isnan(x) || isinf(x)) return x;
  double r = floor(x); if (x - r >= 0.5) r += 1;
  return r == 0 && (x < 0 || signbit(x)) ? -0.0 : r;
}
static double sts_min(double a, double b) { if (isnan(a) || isnan(b)) return NAN; if (a == b) return signbit(a) ? a : b; return a < b ? a : b; }
static double sts_max(double a, double b) { if (isnan(a) || isnan(b)) return NAN; if (a == b) return signbit(a) ? b : a; return a > b ? a : b; }
static double sts_sign(double x) { return isnan(x) ? x : x > 0 ? 1 : x < 0 ? -1 : x; }
static inline bool sts_isfinite(double x) { return !isnan(x) && !isinf(x); }
static inline bool sts_isnan(double x) { return isnan(x); }
static inline bool sts_isint(double x) { return !isnan(x) && !isinf(x) && trunc(x) == x; }

static void *sts_ptr_in(sts_val v) { (void)v; sts_fail("Ptr is C-only"); return 0; }
static sts_val sts_ptr_out(void *p) { (void)p; sts_fail("Ptr is C-only"); return 0; }
STS_IMP(sts_box_ref) sts_val sts_box_ref(sts_val obj);
STS_IMP(sts_box_unref) sts_val sts_box_unref(sts_val ref);

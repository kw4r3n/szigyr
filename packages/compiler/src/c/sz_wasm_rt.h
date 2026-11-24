// Freestanding C11 runtime for the Wasm backend (Q280, Q281). Zero libc / WASI dependency.
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

#define SZ_IMP(name) __attribute__((import_module("env"), import_name(#name)))
#define SZ_EXP(name) __attribute__((export_name(#name)))

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
#define SZ_NO_BUILTIN __attribute__((no_builtin("memcpy", "memmove", "memset")))
#else
#define SZ_NO_BUILTIN
#endif

// Provide freestanding memory ops in case clang lowers struct copies or loops to calls.
SZ_NO_BUILTIN void *memcpy(void *dst, const void *src, size_t n) {
  uint8_t *d = (uint8_t *)dst; const uint8_t *s = (const uint8_t *)src;
  for (size_t i = 0; i < n; i++) d[i] = s[i];
  return dst;
}
SZ_NO_BUILTIN void *memmove(void *dst, const void *src, size_t n) {
  uint8_t *d = (uint8_t *)dst; const uint8_t *s = (const uint8_t *)src;
  if (d < s) for (size_t i = 0; i < n; i++) d[i] = s[i];
  else if (d > s) for (size_t i = n; i > 0; i--) d[i - 1] = s[i - 1];
  return dst;
}
SZ_NO_BUILTIN void *memset(void *dst, int c, size_t n) {
  uint8_t *d = (uint8_t *)dst; uint8_t v = (uint8_t)c;
  for (size_t i = 0; i < n; i++) d[i] = v;
  return dst;
}

typedef int32_t sz_val;
typedef struct { sz_val obj; void *data; uint32_t len, cap, esize; } sz_vec;
typedef struct { void *data; uint32_t len; } sz_slice;
typedef struct { uint32_t pool, gen, idx; } sz_handle;
typedef struct { bool some; } sz_null;

SZ_IMP(sz_trap) _Noreturn void sz_js_trap(int32_t code, int32_t pos);
SZ_IMP(sz_fail) _Noreturn void sz_js_fail(const char *msg);
SZ_IMP(sz_fmod) double sz_fmod(double a, double b);

SZ_IMP(sz_get) sz_val sz_get(sz_val o, const char *k);
SZ_IMP(sz_set) void sz_set(sz_val o, const char *k, sz_val v);
SZ_IMP(sz_mkobj) sz_val sz_mkobj(void);
SZ_IMP(sz_num) double sz_num(sz_val v);
SZ_IMP(sz_i64) int64_t sz_i64(sz_val v);
SZ_IMP(sz_u64) uint64_t sz_u64(sz_val v);
SZ_IMP(sz_bool) int32_t sz_js_bool(sz_val v);
SZ_IMP(sz_mknum) sz_val sz_mknum(double d);
SZ_IMP(sz_mki64) sz_val sz_mki64(int64_t x);
SZ_IMP(sz_mku64) sz_val sz_mku64(uint64_t x);
SZ_IMP(sz_mkbool) sz_val sz_js_mkbool(int32_t b);
SZ_IMP(sz_mknull) sz_val sz_mknull(void);
SZ_IMP(sz_isnull) int32_t sz_js_isnull(sz_val v);
SZ_IMP(sz_mklit) sz_val sz_mklit(int32_t k);
SZ_IMP(sz_lit_in) int32_t sz_lit_in(sz_val v);
SZ_IMP(sz_callm) sz_val sz_callm(sz_val o, const char *m, uint32_t n, sz_val *a);

SZ_IMP(sz_reg_wb) void sz_reg_wb(int32_t id, void *fr);
SZ_IMP(sz_clear_wb) void sz_clear_wb(void);

SZ_IMP(sz_vec_in) void sz_js_vec_in(sz_val o, uint32_t es, const char *desc, uint32_t *out3);
SZ_IMP(sz_vec_create) sz_val sz_js_vec_create(sz_val alloc, uint32_t cap, const char *elem, int32_t pos);
SZ_IMP(sz_vec_grow) void sz_js_vec_grow(sz_val o, void *old_data, uint32_t cap, uint32_t len, uint32_t esize, int32_t pos, uint32_t *out2);
SZ_IMP(sz_vec_sync) void sz_js_vec_sync(sz_val o, uint32_t len);
SZ_IMP(sz_slice_in) void sz_js_slice_in(sz_val o, uint32_t es, const char *desc, uint32_t *out2);

SZ_IMP(sz_pool_in) void sz_js_pool_in(sz_val o, uint32_t es, const char *desc, uint32_t *u7, double *d2);
SZ_IMP(sz_pool_create) sz_val sz_js_pool_create(sz_val alloc, uint32_t cap, const char *elem, int32_t pos);
SZ_IMP(sz_pool_sync) void sz_js_pool_sync(sz_val o, uint32_t len, double freeHead, double nextFresh);

SZ_IMP(sz_arena_in) void sz_js_arena_in(sz_val o, uint32_t *u4);
SZ_IMP(sz_arena_create) sz_val sz_js_arena_create(sz_val alloc, uint32_t bytes, int32_t pos);
SZ_IMP(sz_arena_note) void sz_js_arena_note(sz_val o, uint32_t off, const char *desc);
SZ_IMP(sz_arena_reset_notes) void sz_js_arena_reset_notes(sz_val o);
SZ_IMP(sz_arena_sync) void sz_js_arena_sync(sz_val o, uint32_t used, uint32_t gen);

SZ_IMP(sz_ring_in) uint32_t sz_js_ring_in(sz_val o, const char *desc);
SZ_IMP(sz_ring_create) sz_val sz_js_ring_create(sz_val alloc, uint32_t cap, const char *elem, int32_t pos);
SZ_IMP(sz_ring_push) int32_t sz_wasm_ring_push(sz_val o, const void *src, uint32_t esize);
SZ_IMP(sz_ring_pop) int32_t sz_wasm_ring_pop(sz_val o, void *dst, uint32_t esize);

static bool sz_bool(sz_val v) { return sz_js_bool(v) != 0; }
static sz_val sz_mkbool(bool b) { return sz_js_mkbool(b ? 1 : 0); }
static bool sz_isnull(sz_val v) { return sz_js_isnull(v) != 0; }

__attribute__((cold)) _Noreturn static void sz_trap(int code, int pos) { sz_js_trap(code, pos); }
__attribute__((cold)) _Noreturn static void sz_fail(const char *msg) { sz_js_fail(msg); }

static int32_t sz_depth = 0;
SZ_EXP(sz_get_depth) int32_t sz_get_depth(void) { return sz_depth; }
SZ_EXP(sz_set_depth) void sz_set_depth(int32_t d) { sz_depth = d; }
// Linked with `-Wl,--stack-first -Wl,-z,stack-size=1048576`: guard below 64 KiB catches frame overflow before SP hits 0.
static inline bool sz_stack_low(void) { volatile uint8_t b; return (uintptr_t)&b < 65536u; }
#define SZ_STACK_LOW() sz_stack_low()

// Linear-memory coalescing heap allocator (16-byte aligned headers and payloads).
extern uint8_t __heap_base;
static _Alignas(16) uint8_t sz_empty[16];
SZ_EXP(sz_empty_ptr) void *sz_empty_ptr(void) { return sz_empty; }

typedef struct sz_blk {
  uint32_t size;
  uint32_t free;
  struct sz_blk *prev;
  struct sz_blk *next;
} sz_blk;
_Static_assert(sizeof(sz_blk) == 16, "sz_blk must be 16 bytes");

typedef struct {
  sz_blk *fprev;
  sz_blk *fnext;
} sz_fnode;
_Static_assert(sizeof(sz_fnode) <= 16, "sz_fnode must fit in minimum 16-byte payload");
_Static_assert(_Alignof(sz_fnode) <= 16, "sz_fnode alignment must not exceed 16");

static uint8_t *sz_heap_cur = 0;
static sz_blk *sz_heap_head = 0;
static sz_blk *sz_heap_tail = 0;
static sz_blk *sz_free_bins[32];
static uint32_t sz_free_mask = 0;

static inline sz_fnode *sz_fn(sz_blk *b) { return (sz_fnode *)(b + 1); }

static inline uint32_t sz_bin(uint32_t s) {
  return s <= 112u ? (s >> 4) - 1u : 31u - (uint32_t)__builtin_clz(s);
}

static void sz_free_add(sz_blk *b) {
  uint32_t k = sz_bin(b->size);
  sz_blk *head = sz_free_bins[k];
  sz_fnode *n = sz_fn(b);
  n->fprev = NULL;
  n->fnext = head;
  if (head) sz_fn(head)->fprev = b;
  sz_free_bins[k] = b;
  sz_free_mask |= 1u << k;
}

static void sz_free_del(sz_blk *b) {
  uint32_t k = sz_bin(b->size);
  sz_fnode *n = sz_fn(b);
  if (n->fprev) sz_fn(n->fprev)->fnext = n->fnext;
  else sz_free_bins[k] = n->fnext;
  if (n->fnext) sz_fn(n->fnext)->fprev = n->fprev;
  if (!sz_free_bins[k]) sz_free_mask &= ~(1u << k);
}

static void sz_heap_init(void) {
  if (sz_heap_cur) return;
  uintptr_t b = ((uintptr_t)&__heap_base + 15u) & ~(uintptr_t)15u;
  size_t have = __builtin_wasm_memory_size(0) * 65536u;
  if (b > have) {
    size_t need = (b - have + 65535u) >> 16;
    if (__builtin_wasm_memory_grow(0, need) == (size_t)-1) return;
  }
  sz_heap_cur = (uint8_t *)b;
}

static void *sz_malloc(size_t n) {
  sz_heap_init();
  if (!sz_heap_cur) return NULL;
  if (n > (size_t)UINT32_MAX - 16u) return NULL;
  uint32_t req = n == 0 ? 16u : (uint32_t)((n + 15u) & ~(size_t)15u);
  uint32_t k = sz_bin(req);
  sz_blk *b = NULL;
  if (sz_free_mask & (1u << k)) {
    if (k < 7u) {
      b = sz_free_bins[k];
    } else {
      // shortcut: scans at most 16 blocks in the same non-exact size bin before checking a larger bin, upgrade to TLSF sub-bins if fragmentation matters
      uint32_t lim = 16u;
      for (sz_blk *c = sz_free_bins[k]; c && lim; c = sz_fn(c)->fnext, lim--) {
        if (c->size >= req) { b = c; break; }
      }
    }
  }
  if (!b && k < 31u) {
    uint32_t hi = sz_free_mask & (~0u << (k + 1u));
    if (hi) b = sz_free_bins[(uint32_t)__builtin_ctz(hi)];
  }
  if (b) {
    sz_free_del(b);
    if (b->size - req >= 32u) {
      sz_blk *rem = (sz_blk *)((uint8_t *)(b + 1) + req);
      rem->size = b->size - req - 16u;
      rem->free = 1;
      rem->prev = b;
      rem->next = b->next;
      if (b->next) b->next->prev = rem; else sz_heap_tail = rem;
      b->next = rem;
      b->size = req;
      sz_free_add(rem);
    }
    b->free = 0;
    return b + 1;
  }
  uint64_t total = (uint64_t)(uintptr_t)sz_heap_cur + 16ull + req;
  if (total > (uint64_t)UINT32_MAX) return NULL;
  size_t have = __builtin_wasm_memory_size(0) * 65536u;
  if (total > have) {
    uint64_t need = ((total - have) + 65535ull) >> 16;
    if (need > (uint64_t)SIZE_MAX || __builtin_wasm_memory_grow(0, (size_t)need) == (size_t)-1) return NULL;
  }
  b = (sz_blk *)sz_heap_cur;
  sz_heap_cur += 16u + req;
  b->size = req;
  b->free = 0;
  b->prev = sz_heap_tail;
  b->next = NULL;
  if (sz_heap_tail) sz_heap_tail->next = b; else sz_heap_head = b;
  sz_heap_tail = b;
  return b + 1;
}

static void *sz_calloc(size_t count, size_t size) {
  if (count && size > (size_t)UINT32_MAX / count) return NULL;
  size_t tot = count * size;
  void *p = sz_malloc(tot);
  if (p) memset(p, 0, tot);
  return p;
}

static void sz_free(void *p) {
  if (!p) return;
  sz_blk *b = ((sz_blk *)p) - 1;
  b->free = 1;
  while (b->next && b->next->free) {
    sz_blk *nx = b->next;
    sz_free_del(nx);
    b->size += 16u + nx->size;
    b->next = nx->next;
    if (b->next) b->next->prev = b; else sz_heap_tail = b;
  }
  while (b->prev && b->prev->free) {
    sz_blk *pv = b->prev;
    sz_free_del(pv);
    pv->size += 16u + b->size;
    pv->next = b->next;
    if (pv->next) pv->next->prev = pv; else sz_heap_tail = pv;
    b = pv;
  }
  if (b == sz_heap_tail) {
    sz_heap_cur = (uint8_t *)b;
    sz_heap_tail = b->prev;
    if (sz_heap_tail) sz_heap_tail->next = NULL; else sz_heap_head = NULL;
  } else {
    sz_free_add(b);
  }
}

static void *sz_realloc(void *p, size_t n) {
  if (!p) return sz_malloc(n);
  sz_blk *b = ((sz_blk *)p) - 1;
  if (b->size >= n) return p;
  void *q = sz_malloc(n);
  if (!q) return NULL;
  memcpy(q, p, b->size < n ? b->size : n);
  sz_free(p);
  return q;
}

SZ_EXP(sz_alloc) void *sz_wasm_alloc(uint32_t n) { return sz_malloc(n); }
SZ_EXP(sz_dealloc) void sz_wasm_dealloc(void *p) { sz_free(p); }

#define malloc sz_malloc
#define calloc sz_calloc
#define realloc sz_realloc
#define free sz_free

typedef struct sz_defer { void (*fn)(void *); void *data; struct sz_defer *prev; } sz_defer;
static sz_defer *sz_defer_head, *sz_defer_base;
static void sz_defer_push(sz_defer *node, void (*fn)(void *), void *data) {
  node->fn = fn; node->data = data; node->prev = sz_defer_head;
  sz_defer_head = node;
}
static void sz_defer_pop_run(sz_defer *mark) {
  while (sz_defer_head && sz_defer_head != mark) {
    sz_defer *d = sz_defer_head;
    sz_defer_head = d->prev;
    if (d->fn) d->fn(d->data);
  }
}
SZ_EXP(sz_defer_enter) uint32_t sz_defer_enter(void) {
  uint32_t prev = (uint32_t)(uintptr_t)sz_defer_base;
  sz_defer_base = sz_defer_head;
  return prev;
}
SZ_EXP(sz_defer_step) uint32_t sz_defer_step(void) {
  if (!sz_defer_head || sz_defer_head == sz_defer_base) return 0;
  sz_defer *d = sz_defer_head;
  sz_defer_head = d->prev;
  if (d->fn) d->fn(d->data);
  return 1;
}
SZ_EXP(sz_defer_leave) void sz_defer_leave(uint32_t prev) {
  sz_defer_head = sz_defer_base;
  sz_defer_base = (sz_defer *)(uintptr_t)prev;
}

// Vec handles live until the boundary call returns; the list slice [v0..n) is synced in finally.
static sz_vec **sz_vecs; static size_t sz_nvecs, sz_capvecs;
static sz_vec *sz_vec_new(void) {
  if (sz_nvecs == sz_capvecs) {
    size_t c_ = sz_capvecs ? sz_capvecs * 2 : 16;
    void *p_ = realloc(sz_vecs, c_ * sizeof *sz_vecs);
    if (!p_) sz_fail("out of memory");
    sz_vecs = p_; sz_capvecs = c_;
  }
  sz_vec *v = calloc(1, sizeof *v);
  if (!v) sz_fail("out of memory");
  return sz_vecs[sz_nvecs++] = v;
}
static sz_vec *sz_vec_in(sz_val o, uint32_t es, const char *desc) {
  sz_vec *v = sz_vec_new(); v->obj = o; v->esize = es;
  uint32_t out[3];
  sz_js_vec_in(o, es, desc, out);
  v->data = (void *)(uintptr_t)out[0];
  v->len = out[1];
  v->cap = out[2];
  return v;
}
static sz_vec *sz_vec_create(sz_val alloc, uint32_t cap, const char *elem, uint32_t es, int pos) {
  uint32_t acap = cap < 4u ? 4u : cap;
  if ((uint64_t)acap * es >= 0x100000000ULL) sz_trap(6, pos);
  sz_val r = sz_js_vec_create(alloc, cap, elem, pos);
  return sz_vec_in(r, es, elem);
}
static void sz_vec_grow(sz_vec *v, int pos) {
  if (v->len == UINT32_MAX) sz_trap(6, pos);
  uint64_t c = (uint64_t)v->len * 2;
  uint32_t cap = c > UINT32_MAX ? UINT32_MAX : c < 4 ? 4 : (uint32_t)c;
  if ((uint64_t)cap * v->esize >= 0x100000000ULL) sz_trap(6, pos);
  uint32_t out[2];
  sz_js_vec_grow(v->obj, v->data, cap, v->len, v->esize, pos, out);
  v->data = (void *)(uintptr_t)out[0];
  v->cap = out[1];
}

// Pool handles live until the boundary call returns, like Vec handles.
typedef struct { sz_val obj; void *data; uint32_t len, cap, esize; uint32_t *gens; uint8_t *occ; int32_t *nextFree; int64_t freeHead, nextFresh; uint32_t id; } sz_pool;
static sz_pool **sz_pools; static size_t sz_npools, sz_cappools;
static sz_pool *sz_pool_new(void) {
  if (sz_npools == sz_cappools) {
    size_t c_ = sz_cappools ? sz_cappools * 2 : 16;
    void *p_ = realloc(sz_pools, c_ * sizeof *sz_pools);
    if (!p_) sz_fail("out of memory");
    sz_pools = p_; sz_cappools = c_;
  }
  sz_pool *p = calloc(1, sizeof *p);
  if (!p) sz_fail("out of memory");
  return sz_pools[sz_npools++] = p;
}
static sz_pool *sz_pool_in(sz_val o, uint32_t es, const char *desc) {
  sz_pool *p = sz_pool_new(); p->obj = o; p->esize = es;
  uint32_t u[7]; double d[2];
  sz_js_pool_in(o, es, desc, u, d);
  p->data = (void *)(uintptr_t)u[0];
  p->gens = (uint32_t *)(uintptr_t)u[1];
  p->occ = (uint8_t *)(uintptr_t)u[2];
  p->nextFree = (int32_t *)(uintptr_t)u[3];
  p->len = u[4]; p->cap = u[5]; p->id = u[6];
  p->freeHead = (int64_t)d[0]; p->nextFresh = (int64_t)d[1];
  return p;
}
static sz_pool *sz_pool_create(sz_val alloc, uint32_t cap, const char *elem, uint32_t es, int pos) {
  sz_val r = sz_js_pool_create(alloc, cap, elem, pos);
  return sz_pool_in(r, es, elem);
}
static bool sz_pool_valid(sz_pool *p, sz_handle h) { return h.pool == p->id && h.idx < p->cap && p->occ[h.idx] && p->gens[h.idx] == h.gen; }
static sz_handle sz_hdl_in(sz_val o) {
  sz_handle h;
  h.pool = (uint32_t)sz_num(sz_get(o, "pool"));
  h.gen = (uint32_t)sz_num(sz_get(o, "gen"));
  h.idx = (uint32_t)sz_num(sz_get(o, "idx"));
  return h;
}
static sz_val sz_hdl_out(sz_handle h) {
  sz_val o = sz_mkobj();
  sz_set(o, "pool", sz_mknum((double)h.pool));
  sz_set(o, "gen", sz_mknum((double)h.gen));
  sz_set(o, "idx", sz_mknum((double)h.idx));
  return o;
}
static inline bool sz_hdl_eq(sz_handle a, sz_handle b) { return a.pool == b.pool && a.gen == b.gen && a.idx == b.idx; }

typedef struct { uint32_t arena, gen, off, len; } sz_abuf;
static sz_abuf sz_abuf_in(sz_val o) {
  sz_abuf b;
  b.arena = (uint32_t)sz_num(sz_get(o, "arena"));
  b.gen = (uint32_t)sz_num(sz_get(o, "gen"));
  b.off = (uint32_t)sz_num(sz_get(o, "off"));
  b.len = (uint32_t)sz_num(sz_get(o, "length"));
  return b;
}
static sz_val sz_abuf_out(sz_abuf b) {
  sz_val o = sz_mkobj();
  sz_set(o, "arena", sz_mknum((double)b.arena));
  sz_set(o, "gen", sz_mknum((double)b.gen));
  sz_set(o, "off", sz_mknum((double)b.off));
  sz_set(o, "length", sz_mknum((double)b.len));
  return o;
}

// Arena handles live until the boundary call returns, like Pool handles.
typedef struct { sz_val obj; void *data; uint32_t cap, used, gen, id; } sz_arena;
static sz_arena **sz_arenas; static size_t sz_narenas, sz_caparenas;
static sz_arena *sz_arena_new(void) {
  if (sz_narenas == sz_caparenas) {
    size_t c_ = sz_caparenas ? sz_caparenas * 2 : 16;
    void *p_ = realloc(sz_arenas, c_ * sizeof *sz_arenas);
    if (!p_) sz_fail("out of memory");
    sz_arenas = p_; sz_caparenas = c_;
  }
  sz_arena *a = calloc(1, sizeof *a);
  if (!a) sz_fail("out of memory");
  return sz_arenas[sz_narenas++] = a;
}
static sz_arena *sz_arena_in(sz_val o) {
  sz_arena *a = sz_arena_new(); a->obj = o;
  uint32_t u[4];
  sz_js_arena_in(o, u);
  a->data = (void *)(uintptr_t)u[0];
  a->cap = u[1]; a->used = u[2]; a->gen = u[3];
  a->id = (uint32_t)sz_num(sz_get(o, "id"));
  return a;
}
static sz_arena *sz_arena_create(sz_val alloc, uint32_t bytes, int pos) {
  sz_val r = sz_js_arena_create(alloc, bytes, pos);
  return sz_arena_in(r);
}
static void sz_vec_free_detached(sz_vec *v) { if (v) { free(v->data); free(v); } }
static sz_vec *sz_vec_detach(sz_vec *v) {
  sz_vec *d = calloc(1, sizeof *d); if (!d) sz_fail("out of memory");
  d->obj = 0; d->len = v->len; d->cap = v->len; d->esize = v->esize;
  size_t n = (size_t)v->len * v->esize;
  d->data = malloc(n > 0 ? n : 1);
  if (!d->data) { free(d); sz_fail("out of memory"); }
  if (n > 0) memcpy(d->data, v->data, n);
  return d;
}
static void sz_pool_free_detached(sz_pool *p) { if (p) { free(p->data); free(p->gens); free(p->occ); free(p->nextFree); free(p); } }
static sz_pool *sz_pool_detach(sz_pool *p) {
  sz_pool *d = calloc(1, sizeof *d); if (!d) sz_fail("out of memory");
  d->obj = 0; d->len = p->len; d->cap = p->cap; d->esize = p->esize;
  d->freeHead = p->freeHead; d->nextFresh = p->nextFresh; d->id = p->id;
  if (p->cap > 0) {
    size_t db = (size_t)p->cap * p->esize;
    d->data = malloc(db > 0 ? db : 1);
    d->gens = malloc((size_t)p->cap * sizeof(uint32_t));
    d->occ = malloc((size_t)p->cap);
    d->nextFree = malloc((size_t)p->cap * sizeof(int32_t));
    if (!d->data || !d->gens || !d->occ || !d->nextFree) { sz_pool_free_detached(d); sz_fail("out of memory"); }
    if (db > 0) memcpy(d->data, p->data, db);
    memcpy(d->gens, p->gens, (size_t)p->cap * sizeof(uint32_t));
    memcpy(d->occ, p->occ, (size_t)p->cap);
    memcpy(d->nextFree, p->nextFree, (size_t)p->cap * sizeof(int32_t));
  }
  return d;
}
static void sz_arena_free_detached(sz_arena *a) { if (a) { free(a->data); free(a); } }
static sz_arena *sz_arena_detach(sz_arena *a) {
  sz_arena *d = calloc(1, sizeof *d); if (!d) sz_fail("out of memory");
  d->obj = 0; d->cap = a->cap; d->used = a->used; d->gen = a->gen; d->id = a->id;
  d->data = malloc(a->cap > 0 ? a->cap : 1);
  if (!d->data) { free(d); sz_fail("out of memory"); }
  if (a->used > 0) memcpy(d->data, a->data, a->used);
  return d;
}
static void sz_arena_note(sz_arena *a, uint32_t off, const char *desc) { if (!a->obj) return; sz_js_arena_note(a->obj, off, desc); }
static void sz_arena_reset_notes(sz_arena *a) { if (!a->obj) return; sz_js_arena_reset_notes(a->obj); }
static sz_slice sz_arena_view(sz_arena *a, sz_abuf b, int pos) {
  if (b.arena != a->id || b.gen != a->gen) sz_trap(12, pos);
  return (sz_slice){ (char *)a->data + b.off, b.len };
}

SZ_EXP(sz_nvecs_get) uint32_t sz_nvecs_get(void) { return (uint32_t)sz_nvecs; }
SZ_EXP(sz_npools_get) uint32_t sz_npools_get(void) { return (uint32_t)sz_npools; }
SZ_EXP(sz_narenas_get) uint32_t sz_narenas_get(void) { return (uint32_t)sz_narenas; }
SZ_EXP(sz_sync_frame) void sz_sync_frame(uint32_t v0, uint32_t p0, uint32_t a0) {
  for (size_t i = v0; i < sz_nvecs; i++) { sz_js_vec_sync(sz_vecs[i]->obj, sz_vecs[i]->len); free(sz_vecs[i]); }
  sz_nvecs = v0;
  for (size_t i = p0; i < sz_npools; i++) { sz_pool *p = sz_pools[i]; sz_js_pool_sync(p->obj, p->len, (double)p->freeHead, (double)p->nextFresh); free(p); }
  sz_npools = p0;
  for (size_t i = a0; i < sz_narenas; i++) { sz_arena *a = sz_arenas[i]; sz_js_arena_sync(a->obj, a->used, a->gen); free(a); }
  sz_narenas = a0;
}

typedef struct { sz_val obj; uint32_t cap, esize; } sz_ring;
static sz_ring sz_ring_in(sz_val o, uint32_t es, const char *desc) {
  sz_ring r; r.obj = o; r.esize = es; r.cap = sz_js_ring_in(o, desc); return r;
}
static sz_val sz_ring_create(sz_val alloc, uint32_t cap, const char *elem, int pos) {
  if (cap == 0 || cap > 0x80000000u || (cap & (cap - 1)) != 0) sz_trap(14, pos);
  return sz_js_ring_create(alloc, cap, elem, pos);
}

static sz_slice sz_vslice(sz_vec *v) { return (sz_slice){ v->data, v->len }; }
static sz_slice sz_slice_in(sz_val o, uint32_t es, const char *desc) {
  uint32_t out[2];
  sz_js_slice_in(o, es, desc, out);
  return (sz_slice){ (void *)(uintptr_t)out[0], out[1] };
}

// Split 64-bit multiplies into 32-bit half-products to avoid compiler-rt `__multi3` under freestanding wasm32.
static uint64_t sz_mulu64(uint64_t a, uint64_t b, int pos) {
  uint64_t ah = a >> 32, al = (uint32_t)a, bh = b >> 32, bl = (uint32_t)b;
  if (ah && bh) sz_trap(1, pos);
  uint64_t p0 = al * bl, p1 = ah * bl, p2 = al * bh;
  if ((p1 >> 32) || (p2 >> 32)) sz_trap(1, pos);
  uint64_t mid = (p0 >> 32) + (uint32_t)p1 + (uint32_t)p2;
  if (mid >> 32) sz_trap(1, pos);
  return (mid << 32) | (uint32_t)p0;
}
static int64_t sz_muli64(int64_t a, int64_t b, int pos) {
  if (a == 0 || b == 0) return 0;
  bool neg = (a < 0) != (b < 0);
  uint64_t ua = a < 0 ? (uint64_t)0 - (uint64_t)a : (uint64_t)a;
  uint64_t ub = b < 0 ? (uint64_t)0 - (uint64_t)b : (uint64_t)b;
  uint64_t ah = ua >> 32, al = (uint32_t)ua, bh = ub >> 32, bl = (uint32_t)ub;
  if (ah && bh) sz_trap(1, pos);
  uint64_t p0 = al * bl, p1 = ah * bl, p2 = al * bh;
  if ((p1 >> 32) || (p2 >> 32)) sz_trap(1, pos);
  uint64_t mid = (p0 >> 32) + (uint32_t)p1 + (uint32_t)p2;
  if (mid >> 32) sz_trap(1, pos);
  uint64_t ur = (mid << 32) | (uint32_t)p0;
  uint64_t lim = neg ? ((uint64_t)INT64_MAX + 1ULL) : (uint64_t)INT64_MAX;
  if (ur > lim) sz_trap(1, pos);
  return neg ? (int64_t)((uint64_t)0 - ur) : (int64_t)ur;
}
#define SZ_MULI64 sz_muli64
#define SZ_MULU64 sz_mulu64

static void *sz_ptr_in(sz_val v) { (void)v; sz_fail("Ptr is C-only"); return 0; }
static sz_val sz_ptr_out(void *p) { (void)p; sz_fail("Ptr is C-only"); return 0; }
SZ_IMP(sz_box_ref) sz_val sz_box_ref(sz_val obj);
SZ_IMP(sz_box_unref) sz_val sz_box_unref(sz_val ref);

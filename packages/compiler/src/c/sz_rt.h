// C runtime for the strict / rt backend (D101-D103). Included once at the top of the generated translation unit.
#define _GNU_SOURCE
#include <pthread.h>
#include <node_api.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <setjmp.h>
#include <stdatomic.h>

typedef napi_value sz_val;
static double sz_fmod(double a, double b) { return fmod(a, b); }

typedef struct { napi_value obj; void *data; uint32_t len, cap, esize; napi_typedarray_type tt; } sz_vec;
typedef struct { void *data; uint32_t len; } sz_slice;
typedef struct { uint32_t pool, gen, idx; } sz_handle; // a Pool handle: three u32s, 12 bytes (Q188 (a))
typedef struct { bool some; } sz_null; // a value of type `null`: never present, so `x === null` reads `!x.some` as for `T | null`

static _Thread_local napi_env sz_env;
static _Thread_local napi_ref sz_host; // { trap(code, file, line, col), create(alloc, cap, elem) }
static _Thread_local jmp_buf sz_jb;
static _Thread_local int sz_trap_code, sz_trap_pos, sz_depth;
static _Thread_local const char *sz_err; // internal (non-trap) error message

// The program's end flag and the first trap (SPEC 14.6 / 15.4): one flag per program,
// shared by every thread. It is set when any thread traps and when main ends. The first
// trap to claim the record is the one reported trap; later claims are discarded. The
// record is written before the flag is stored, under the same mutex, so a reader that
// sees the flag up can take the record.
// D165: two programs can share this .so in one process (a Worker each, D111), so the record
// is per program: main's `init` makes one per thread, an isolate's `init` names its program's,
// and a foreign C thread (no `init`) uses the program loaded last (Q270).
typedef struct { _Atomic int done, ready; pthread_mutex_t mu; int code, pos, taken; } sz_prog_t;
static _Thread_local sz_prog_t *sz_pg;
static sz_prog_t *_Atomic sz_pg_last;
static sz_prog_t sz_pg_none = { .mu = PTHREAD_MUTEX_INITIALIZER }; // before any init
static sz_prog_t *sz_cur(void) { sz_prog_t *p = sz_pg; if (!p) p = atomic_load(&sz_pg_last); return p ? p : &sz_pg_none; }
static void sz_claim_trap(int code, int pos) {
  sz_prog_t *g = sz_cur();
  pthread_mutex_lock(&g->mu);
  if (!atomic_load(&g->ready)) { g->code = code; g->pos = pos; g->taken = 0; atomic_store(&g->ready, 1); }
  atomic_store(&g->done, 1);
  pthread_mutex_unlock(&g->mu);
}
/** Takes the recorded trap if it has not been reported yet (15.4: exactly one is reported). */
static int sz_take_ftrap(int *code, int *pos) {
  sz_prog_t *g = sz_cur();
  if (!atomic_load(&g->ready)) return 0;
  pthread_mutex_lock(&g->mu);
  int got = atomic_load(&g->ready) && !g->taken;
  if (got) { *code = g->code; *pos = g->pos; g->taken = 1; }
  pthread_mutex_unlock(&g->mu);
  return got;
}
static void sz_ftrap_reset(sz_prog_t *g) {
  pthread_mutex_lock(&g->mu);
  g->code = 0; g->pos = 0; g->taken = 0;
  atomic_store(&g->ready, 0);
  atomic_store(&g->done, 0);
  pthread_mutex_unlock(&g->mu);
}

typedef struct sz_defer { void (*fn)(void *); void *data; struct sz_defer *prev; } sz_defer;
static _Thread_local sz_defer *sz_defer_head, *sz_defer_base;
static _Thread_local int sz_unwinding;
_Noreturn static void sz_fail(const char *msg);
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
static void sz_defer_unwind(void) {
  if (sz_unwinding) return;
  sz_unwinding = 1;
  jmp_buf saved_jb;
  memcpy(saved_jb, sz_jb, sizeof saved_jb);
  int saved_code = sz_trap_code, saved_pos = sz_trap_pos;
  const char *saved_err = sz_err;
  while (sz_defer_head && sz_defer_head != sz_defer_base) {
    sz_defer *d = sz_defer_head;
    sz_defer_head = d->prev;
    if (!d->fn) continue;
    sz_defer *volatile inner_base = sz_defer_head;
    if (setjmp(sz_jb) == 0) {
      d->fn(d->data);
    } else {
      while (sz_defer_head && sz_defer_head != inner_base) {
        sz_defer *volatile d2 = sz_defer_head;
        sz_defer_head = d2->prev;
        if (!d2->fn) continue;
        if (setjmp(sz_jb) == 0) d2->fn(d2->data);
      }
    }
  }
  memcpy(sz_jb, saved_jb, sizeof sz_jb);
  sz_trap_code = saved_code;
  sz_trap_pos = saved_pos;
  sz_err = saved_err;
  sz_unwinding = 0;
}

__attribute__((cold)) _Noreturn static void sz_trap(int code, int pos) { if (sz_unwinding) longjmp(sz_jb, 1); if (code >= 1) sz_claim_trap(code, pos); sz_trap_code = code; sz_trap_pos = pos; sz_defer_unwind(); longjmp(sz_jb, 1); }
_Noreturn static void sz_fail(const char *msg) { if (!sz_unwinding) sz_err = msg; sz_trap(0, 0); }
#define SZ_OK(call) do { if ((call) != napi_ok) sz_fail(#call); } while (0)
/** Q182: calls trap T006 once the stack is within a margin of this thread's real limit, so a large frame cannot overflow it. */
static _Thread_local uintptr_t sz_stack_lim;
static void sz_stack_init(void) {
  pthread_attr_t a; void *lo; size_t n;
  if (pthread_getattr_np(pthread_self(), &a) != 0 || pthread_attr_getstack(&a, &lo, &n) != 0) sz_fail("cannot read the stack bounds");
  pthread_attr_destroy(&a);
  size_t margin = n / 8 > (size_t)256 << 10 ? n / 8 : (size_t)256 << 10;
  sz_stack_lim = (uintptr_t)lo + margin;
}
#define SZ_STACK_LOW() ((uintptr_t)__builtin_frame_address(0) < sz_stack_lim)
/** A thread C created (14.6): the stack bounds come from the OS where they can be read.
 * Where they cannot, the limit is 1, which no frame address is below, so only the depth
 * limit applies (14.4's undefined behavior 10 covers a stack that is really too small). */
static void sz_tramp_stack_init(void) {
  pthread_attr_t a; void *lo; size_t n;
  if (pthread_getattr_np(pthread_self(), &a) != 0) { sz_stack_lim = 1; return; }
  int ok = pthread_attr_getstack(&a, &lo, &n) == 0;
  pthread_attr_destroy(&a);
  if (!ok) { sz_stack_lim = 1; return; }
  size_t margin = n / 8 > (size_t)256 << 10 ? n / 8 : (size_t)256 << 10;
  sz_stack_lim = (uintptr_t)lo + margin;
}

// Vec handles live until the boundary call returns; the list is reset per entry.
static _Thread_local sz_vec **sz_vecs; static _Thread_local size_t sz_nvecs, sz_capvecs;
static sz_vec *sz_vec_new(void) {
  if (sz_nvecs == sz_capvecs) { size_t c_ = sz_capvecs ? sz_capvecs * 2 : 16; void *p_ = realloc(sz_vecs, c_ * sizeof *sz_vecs); if (!p_) sz_fail("out of memory"); sz_vecs = p_; sz_capvecs = c_; }
  sz_vec *v = calloc(1, sizeof *v); if (!v) sz_fail("out of memory");
  return sz_vecs[sz_nvecs++] = v;
}
static napi_value sz_get(napi_value o, const char *k) { napi_value r; SZ_OK(napi_get_named_property(sz_env, o, k, &r)); return r; }
static void sz_set(napi_value o, const char *k, napi_value v) { SZ_OK(napi_set_named_property(sz_env, o, k, v)); }
static napi_value sz_mkobj(void) { napi_value o; SZ_OK(napi_create_object(sz_env, &o)); return o; }
static uint32_t sz_tbytes(napi_typedarray_type tt) {
  switch (tt) { case napi_int8_array: case napi_uint8_array: return 1; case napi_int16_array: case napi_uint16_array: return 2; case napi_float64_array: case napi_bigint64_array: case napi_biguint64_array: return 8; default: return 4; }
}
static napi_value sz_hostf(const char *k, napi_value *host) { SZ_OK(napi_get_reference_value(sz_env, sz_host, host)); return sz_get(*host, k); }
/** `esize` and `desc` come from the static element type: a number type's name or a layout's JSON (SPEC §10.2, D105). */
static void sz_vec_load(sz_vec *v, const char *desc) {
  napi_value buf = sz_get(v->obj, "buf"); bool ta;
  SZ_OK(napi_is_typedarray(sz_env, buf, &ta));
  if (!ta) { // made where the element type was a type parameter (D100): switch it to its representation
    napi_value host, f = sz_hostf("adopt", &host), args[2] = { v->obj }, r;
    SZ_OK(napi_create_string_utf8(sz_env, desc, NAPI_AUTO_LENGTH, &args[1])); SZ_OK(napi_call_function(sz_env, host, f, 2, args, &r));
    buf = sz_get(v->obj, "buf"); SZ_OK(napi_is_typedarray(sz_env, buf, &ta)); if (!ta) sz_fail("Vec is not backed by a TypedArray");
  }
  size_t n; napi_value ab; size_t off;
  SZ_OK(napi_get_typedarray_info(sz_env, buf, &v->tt, &n, &v->data, &ab, &off));
  size_t cap = n * sz_tbytes(v->tt) / v->esize; v->cap = cap > UINT32_MAX ? UINT32_MAX : (uint32_t)cap;
  double len; SZ_OK(napi_get_value_double(sz_env, sz_get(v->obj, "len"), &len));
  if (!(len >= 0 && len <= v->cap)) sz_fail("Vec length out of range"); v->len = (uint32_t)len;
}
static sz_vec *sz_vec_in(napi_value o, uint32_t es, const char *desc) { sz_vec *v = sz_vec_new(); v->obj = o; v->esize = es; sz_vec_load(v, desc); return v; }
/** A JS exception from the host's allocation (RangeError) is T006 at the call, as in JS (D100, Q035). */
static void sz_alloc_ok(napi_status st, int pos) {
  if (st == napi_ok) return;
  bool pend; napi_value x; if (napi_is_exception_pending(sz_env, &pend) == napi_ok && pend) napi_get_and_clear_last_exception(sz_env, &x);
  sz_trap(6, pos);
}
static sz_vec *sz_vec_create(napi_value alloc, uint32_t cap, const char *elem, uint32_t es, int pos) {
  napi_value host, f = sz_hostf("create", &host), args[3], r;
  args[0] = alloc; SZ_OK(napi_create_uint32(sz_env, cap, &args[1])); SZ_OK(napi_create_string_utf8(sz_env, elem, NAPI_AUTO_LENGTH, &args[2]));
  sz_alloc_ok(napi_call_function(sz_env, host, f, 3, args, &r), pos);
  return sz_vec_in(r, es, elem);
}
/** Growth keeps the length within usize: the capacity doubles up to 2^32 - 1 elements; past that, or when the allocation fails, T006 (D106). */
static void sz_vec_grow(sz_vec *v, int pos) {
  if (v->len == UINT32_MAX) sz_trap(6, pos);
  uint64_t c = (uint64_t)v->len * 2; uint32_t cap = c > UINT32_MAX ? UINT32_MAX : c < 4 ? 4 : (uint32_t)c, len = v->len;
  // through the host: napi_create_arraybuffer aborts the process when V8 is out of memory; a JS RangeError becomes T006 (D106)
  napi_value host, f = sz_hostf("reserve", &host), args[3] = { v->obj }, r;
  SZ_OK(napi_create_uint32(sz_env, cap, &args[1])); SZ_OK(napi_create_uint32(sz_env, len, &args[2]));
  sz_alloc_ok(napi_call_function(sz_env, host, f, 3, args, &r), pos);
  size_t n; napi_value ab, buf = sz_get(v->obj, "buf"); size_t off;
  SZ_OK(napi_get_typedarray_info(sz_env, buf, &v->tt, &n, &v->data, &ab, &off));
  v->cap = cap; v->len = len;
}
/** Boundary exit: lengths changed in C go back to the JS objects. */
static void sz_vec_sync(void) {
  for (size_t i = 0; i < sz_nvecs; i++) { napi_value n; if (napi_create_uint32(sz_env, sz_vecs[i]->len, &n) == napi_ok) napi_set_named_property(sz_env, sz_vecs[i]->obj, "len", n); free(sz_vecs[i]); }
  sz_nvecs = 0;
}
static sz_vec *sz_vec_detach(sz_vec *v) {
  sz_vec *d = calloc(1, sizeof *d); if (!d) sz_fail("out of memory");
  d->obj = 0; d->len = v->len; d->cap = v->len; d->esize = v->esize; d->tt = v->tt;
  size_t n = (size_t)v->len * v->esize;
  d->data = malloc(n > 0 ? n : 1);
  if (!d->data) { free(d); sz_fail("out of memory"); }
  if (n > 0) memcpy(d->data, v->data, n);
  return d;
}
static void sz_vec_free_detached(sz_vec *v) { if (v) { free(v->data); free(v); } }
// Pool handles live until the boundary call returns, like Vec handles; the list is reset per entry.
typedef struct { napi_value obj; void *data; uint32_t len, cap, esize; uint32_t *gens; uint8_t *occ; int32_t *nextFree; int64_t freeHead, nextFresh; uint32_t id; } sz_pool;
static _Thread_local sz_pool **sz_pools; static _Thread_local size_t sz_npools, sz_cappools;
static sz_pool *sz_pool_new(void) {
  if (sz_npools == sz_cappools) { size_t c_ = sz_cappools ? sz_cappools * 2 : 16; void *p_ = realloc(sz_pools, c_ * sizeof *sz_pools); if (!p_) sz_fail("out of memory"); sz_pools = p_; sz_cappools = c_; }
  sz_pool *p = calloc(1, sizeof *p); if (!p) sz_fail("out of memory");
  return sz_pools[sz_npools++] = p;
}
static double sz_pnum(napi_value o, const char *k) { double d; SZ_OK(napi_get_value_double(sz_env, sz_get(o, k), &d)); return d; }
static void *sz_pta(napi_value o, const char *k) { napi_value buf = sz_get(o, k); napi_typedarray_type tt; size_t n, off; napi_value ab; void *d; SZ_OK(napi_get_typedarray_info(sz_env, buf, &tt, &n, &d, &ab, &off)); return d; }
/** `esize` and `desc` come from the static element type, as for Vec (SPEC §10.2, D105). */
static void sz_pool_load(sz_pool *p, const char *desc) {
  napi_value buf = sz_get(p->obj, "buf"); bool ta;
  SZ_OK(napi_is_typedarray(sz_env, buf, &ta));
  if (!ta) { // made where the element type was a type parameter: switch it to its representation
    napi_value host, f = sz_hostf("adoptPool", &host), args[2] = { p->obj }, r;
    SZ_OK(napi_create_string_utf8(sz_env, desc, NAPI_AUTO_LENGTH, &args[1])); SZ_OK(napi_call_function(sz_env, host, f, 2, args, &r));
    buf = sz_get(p->obj, "buf"); SZ_OK(napi_is_typedarray(sz_env, buf, &ta)); if (!ta) sz_fail("Pool is not backed by a TypedArray");
  }
  napi_typedarray_type tt; size_t n, off; napi_value ab;
  SZ_OK(napi_get_typedarray_info(sz_env, buf, &tt, &n, &p->data, &ab, &off));
  p->gens = (uint32_t *)sz_pta(p->obj, "gens"); p->occ = (uint8_t *)sz_pta(p->obj, "occ"); p->nextFree = (int32_t *)sz_pta(p->obj, "nextFree");
  p->len = (uint32_t)sz_pnum(p->obj, "len"); p->cap = (uint32_t)sz_pnum(p->obj, "capacity");
  p->freeHead = (int64_t)sz_pnum(p->obj, "freeHead"); p->nextFresh = (int64_t)sz_pnum(p->obj, "nextFresh");
  p->id = (uint32_t)sz_pnum(p->obj, "id");
}
static sz_pool *sz_pool_in(napi_value o, uint32_t es, const char *desc) { sz_pool *p = sz_pool_new(); p->obj = o; p->esize = es; sz_pool_load(p, desc); return p; }
static sz_pool *sz_pool_create(napi_value alloc, uint32_t cap, const char *elem, uint32_t es, int pos) {
  napi_value host, f = sz_hostf("createPool", &host), args[3], r;
  args[0] = alloc; SZ_OK(napi_create_uint32(sz_env, cap, &args[1])); SZ_OK(napi_create_string_utf8(sz_env, elem, NAPI_AUTO_LENGTH, &args[2]));
  sz_alloc_ok(napi_call_function(sz_env, host, f, 3, args, &r), pos);
  return sz_pool_in(r, es, elem);
}
/** Boundary exit: slot bookkeeping changed in C goes back to the JS object. Element bytes and the gens / occ / nextFree arrays are shared. */
static void sz_pool_sync(void) {
  for (size_t i = 0; i < sz_npools; i++) {
    sz_pool *p = sz_pools[i]; napi_value n;
    if (napi_create_double(sz_env, (double)p->len, &n) == napi_ok) napi_set_named_property(sz_env, p->obj, "len", n);
    if (napi_create_double(sz_env, (double)p->freeHead, &n) == napi_ok) napi_set_named_property(sz_env, p->obj, "freeHead", n);
    if (napi_create_double(sz_env, (double)p->nextFresh, &n) == napi_ok) napi_set_named_property(sz_env, p->obj, "nextFresh", n);
    free(p);
  }
  sz_npools = 0;
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
static bool sz_pool_valid(sz_pool *p, sz_handle h) { return h.pool == p->id && h.idx < p->cap && p->occ[h.idx] && p->gens[h.idx] == h.gen; }
static sz_handle sz_hdl_in(napi_value o) { sz_handle h; h.pool = (uint32_t)sz_pnum(o, "pool"); h.gen = (uint32_t)sz_pnum(o, "gen"); h.idx = (uint32_t)sz_pnum(o, "idx"); return h; }
static napi_value sz_hdl_out(sz_handle h) {
  napi_value o, v; SZ_OK(napi_create_object(sz_env, &o));
  SZ_OK(napi_create_uint32(sz_env, h.pool, &v)); sz_set(o, "pool", v);
  SZ_OK(napi_create_uint32(sz_env, h.gen, &v)); sz_set(o, "gen", v);
  SZ_OK(napi_create_uint32(sz_env, h.idx, &v)); sz_set(o, "idx", v);
  return o;
}
static inline bool sz_hdl_eq(sz_handle a, sz_handle b) { return a.pool == b.pool && a.gen == b.gen && a.idx == b.idx; }
typedef struct { uint32_t arena, gen, off, len; } sz_abuf; // an ArenaBuf: four u32s, 16 bytes (Q188 (b))
static sz_abuf sz_abuf_in(napi_value o) { sz_abuf b; b.arena = (uint32_t)sz_pnum(o, "arena"); b.gen = (uint32_t)sz_pnum(o, "gen"); b.off = (uint32_t)sz_pnum(o, "off"); b.len = (uint32_t)sz_pnum(o, "length"); return b; }
static napi_value sz_abuf_out(sz_abuf b) {
  napi_value o, v; SZ_OK(napi_create_object(sz_env, &o));
  SZ_OK(napi_create_uint32(sz_env, b.arena, &v)); sz_set(o, "arena", v);
  SZ_OK(napi_create_uint32(sz_env, b.gen, &v)); sz_set(o, "gen", v);
  SZ_OK(napi_create_uint32(sz_env, b.off, &v)); sz_set(o, "off", v);
  SZ_OK(napi_create_uint32(sz_env, b.len, &v)); sz_set(o, "length", v);
  return o;
}
// Arena handles live until the boundary call returns, like Pool handles; the list is reset per entry.
typedef struct { napi_value obj; void *data; uint32_t cap, used, gen, id; uint32_t *roff; const char **rdesc; size_t nrec, caprec; } sz_arena;
static _Thread_local sz_arena **sz_arenas; static _Thread_local size_t sz_narenas, sz_caparenas;
static sz_arena *sz_arena_new(void) {
  if (sz_narenas == sz_caparenas) { size_t c_ = sz_caparenas ? sz_caparenas * 2 : 16; void *p_ = realloc(sz_arenas, c_ * sizeof *sz_arenas); if (!p_) sz_fail("out of memory"); sz_arenas = p_; sz_caparenas = c_; }
  sz_arena *a = calloc(1, sizeof *a); if (!a) sz_fail("out of memory");
  return sz_arenas[sz_narenas++] = a;
}
static sz_arena *sz_arena_in(napi_value o) {
  sz_arena *a = sz_arena_new(); a->obj = o;
  napi_value buf = sz_get(o, "buf"); napi_typedarray_type tt; size_t n, off; napi_value ab;
  SZ_OK(napi_get_typedarray_info(sz_env, buf, &tt, &n, &a->data, &ab, &off));
  a->cap = (uint32_t)n;
  a->used = (uint32_t)sz_pnum(o, "used"); a->gen = (uint32_t)sz_pnum(o, "gen"); a->id = (uint32_t)sz_pnum(o, "id");
  return a;
}
static sz_arena *sz_arena_create(napi_value alloc, uint32_t bytes, int pos) {
  napi_value host, f = sz_hostf("createArena", &host), args[2], r;
  args[0] = alloc; SZ_OK(napi_create_uint32(sz_env, bytes, &args[1]));
  sz_alloc_ok(napi_call_function(sz_env, host, f, 2, args, &r), pos);
  return sz_arena_in(r);
}
/** A buf allocated in C: its offset and element kind go to the JS object at the boundary exit,
 * so a type-parameter `view` in managed code can read its bytes (D116). */
static void sz_arena_note(sz_arena *a, uint32_t off, const char *desc) {
  if (!a->obj) return;
  if (a->nrec && a->roff[a->nrec - 1] == off) { a->rdesc[a->nrec - 1] = desc; return; } // Q246: a zero-length alloc leaves `used` in place; JS keeps the last note per offset anyway
  if (a->nrec == a->caprec) {
    size_t c = a->caprec ? a->caprec * 2 : 8;
    uint32_t *o = realloc(a->roff, c * sizeof *o); if (!o) sz_fail("out of memory"); a->roff = o;
    const char **d = realloc(a->rdesc, c * sizeof *d); if (!d) sz_fail("out of memory"); a->rdesc = d;
    a->caprec = c;
  }
  a->roff[a->nrec] = off; a->rdesc[a->nrec++] = desc;
}
#define sz_arena_reset_notes(a) ((a)->nrec = 0)
/** Boundary exit: `used` and `gen` changed in C go back to the JS object, with the notes above. The bytes are shared. */
static void sz_arena_sync(void) {
  for (size_t i = 0; i < sz_narenas; i++) {
    sz_arena *a = sz_arenas[i]; napi_value n;
    if (napi_create_double(sz_env, (double)a->used, &n) == napi_ok) napi_set_named_property(sz_env, a->obj, "used", n);
    if (napi_create_double(sz_env, (double)a->gen, &n) == napi_ok) napi_set_named_property(sz_env, a->obj, "gen", n);
    napi_value f, args[2], r;
    for (size_t k = 0; k < a->nrec; k++)
      if (napi_get_named_property(sz_env, a->obj, "noteC", &f) == napi_ok && napi_create_uint32(sz_env, a->roff[k], &args[0]) == napi_ok
          && napi_create_string_utf8(sz_env, a->rdesc[k], NAPI_AUTO_LENGTH, &args[1]) == napi_ok) napi_call_function(sz_env, a->obj, f, 2, args, &r);
    free(a->roff); free(a->rdesc); free(a);
  }
  sz_narenas = 0;
}
static void sz_arena_free_detached(sz_arena *a) { if (a) { free(a->data); free(a->roff); free(a->rdesc); free(a); } }
static sz_arena *sz_arena_detach(sz_arena *a) {
  sz_arena *d = calloc(1, sizeof *d); if (!d) sz_fail("out of memory");
  d->obj = 0; d->cap = a->cap; d->used = a->used; d->gen = a->gen; d->id = a->id;
  d->data = malloc(a->cap > 0 ? a->cap : 1);
  if (!d->data) { free(d); sz_fail("out of memory"); }
  if (a->cap > 0) memcpy(d->data, a->data, a->cap);
  return d;
}
/** Q188 (b): a buf of another arena, or one taken before `reset`, traps T012 at the member name `view`. */
static sz_slice sz_arena_view(sz_arena *a, sz_abuf b, int pos) {
  if (b.arena != a->id || b.gen != a->gen) sz_trap(12, pos);
  return (sz_slice){ (char *)a->data + b.off, b.len };
}

/** §15.1 (Q199): a ring endpoint. All state lives in the SharedArrayBuffer — the head counter at
 * byte 0, the tail counter at byte 4, the elements at byte 8 in the §10.2 layout — so there is
 * nothing to sync back at the boundary, and the positions are read and written with C11 atomics
 * (acquire / release), the same operations the JS side does with Atomics (D122). */
typedef struct { napi_value obj; uint8_t *base; uint32_t cap, esize; } sz_ring;
static sz_ring sz_ring_in(napi_value o, uint32_t es, const char *desc) {
  napi_value sab = sz_get(o, "sab");
  napi_valuetype vt; SZ_OK(napi_typeof(sz_env, sab, &vt));
  if (vt == napi_null || vt == napi_undefined) { // an element type that was a type parameter: adopt its representation (D105)
    napi_value host, f = sz_hostf("adoptRing", &host), args[2] = { o }, r;
    SZ_OK(napi_create_string_utf8(sz_env, desc, NAPI_AUTO_LENGTH, &args[1]));
    SZ_OK(napi_call_function(sz_env, host, f, 2, args, &r));
    sab = sz_get(o, "sab");
  }
  void *data; size_t len;
  SZ_OK(napi_get_arraybuffer_info(sz_env, sab, &data, &len));
  sz_ring r; r.obj = o; r.base = (uint8_t *)data; r.cap = (uint32_t)sz_pnum(o, "cap"); r.esize = es;
  return r;
}
/** The pair object { tx, rx } the host made; the caller converts its fields with sz_ring_in. */
static napi_value sz_ring_create(napi_value alloc, uint32_t cap, const char *elem, int pos) {
  if (cap == 0 || cap > 0x80000000u || (cap & (cap - 1)) != 0) sz_trap(14, pos); // T014 (§15.1)
  napi_value host, f = sz_hostf("createRing", &host), args[3], r;
  args[0] = alloc; SZ_OK(napi_create_uint32(sz_env, cap, &args[1])); SZ_OK(napi_create_string_utf8(sz_env, elem, NAPI_AUTO_LENGTH, &args[2]));
  sz_alloc_ok(napi_call_function(sz_env, host, f, 3, args, &r), pos);
  return r;
}
static sz_slice sz_vslice(sz_vec *v) { return (sz_slice){ v->data, v->len }; }
static sz_slice sz_slice_in(napi_value o, uint32_t es, const char *desc) {
  napi_value off; bool has; SZ_OK(napi_has_named_property(sz_env, o, "off", &has));
  if (!has) { sz_vec *v = sz_vec_in(o, es, desc); return sz_vslice(v); }
  napi_value buf = sz_get(o, "buf"); bool ta; SZ_OK(napi_is_typedarray(sz_env, buf, &ta));
  if (!ta) { // a view of a Vec made where the element type was a type parameter: switch both to the representation (D105)
    napi_value host, f = sz_hostf("adopt", &host), args[2] = { o }, r;
    SZ_OK(napi_create_string_utf8(sz_env, desc, NAPI_AUTO_LENGTH, &args[1])); SZ_OK(napi_call_function(sz_env, host, f, 2, args, &r));
    buf = sz_get(o, "buf"); SZ_OK(napi_is_typedarray(sz_env, buf, &ta)); if (!ta) sz_fail("Slice is not backed by a TypedArray");
  }
  napi_typedarray_type tt; size_t n, boff; void *data; napi_value ab; SZ_OK(napi_get_typedarray_info(sz_env, buf, &tt, &n, &data, &ab, &boff));
  uint32_t o32, len; off = sz_get(o, "off"); SZ_OK(napi_get_value_uint32(sz_env, off, &o32)); SZ_OK(napi_get_value_uint32(sz_env, sz_get(o, "length"), &len));
  // A packed view whose head is not a multiple of the element size (an Arena view, D116) carries the
  // head byte offset in the Slice's boff property, not in off; numeric views bake it into the TypedArray.
  uint32_t boff2 = 0; bool hasb; SZ_OK(napi_has_named_property(sz_env, o, "boff", &hasb));
  if (hasb) boff2 = (uint32_t)sz_pnum(o, "boff");
  return (sz_slice){ (char *)data + boff2 + (size_t)o32 * es, len };
}
/** Packed element fields (SPEC §10.2). The layout aligns every field and buffers are at least 8-aligned, so the accesses are aligned.
 * They go through may_alias types: an element's bytes are read and written as different C types (a union element changes member,
 * so offset 4 may hold a float and later an int32_t), and may_alias keeps gcc from reordering those accesses (D105). */
typedef float __attribute__((may_alias)) sz_ma_float; typedef double __attribute__((may_alias)) sz_ma_double;
typedef int8_t __attribute__((may_alias)) sz_ma_int8_t; typedef uint8_t __attribute__((may_alias)) sz_ma_uint8_t;
typedef int16_t __attribute__((may_alias)) sz_ma_int16_t; typedef uint16_t __attribute__((may_alias)) sz_ma_uint16_t;
typedef int32_t __attribute__((may_alias)) sz_ma_int32_t; typedef uint32_t __attribute__((may_alias)) sz_ma_uint32_t;
typedef int64_t __attribute__((may_alias)) sz_ma_int64_t; typedef uint64_t __attribute__((may_alias)) sz_ma_uint64_t;
#define SZ_LD(T, p) (*(const sz_ma_##T *)(p))
#define SZ_ST(p, T, v) (*(sz_ma_##T *)(p) = (v))
static uint32_t sz_lidx(const int32_t *tbl, uint32_t n, int32_t id) { for (uint32_t i = 0; i < n; i++) if (tbl[i] == id) return i; sz_fail("bad literal"); return 0; }
static void sz_chk(uint32_t i, uint32_t len, int pos) { if (__builtin_expect(i >= len, 0)) sz_trap(2, pos); }
/** Q190 (b): the byte ranges of two slices overlap; a zero-length range overlaps nothing. `az` / `bz`: each side's element size (arena views of different types). */
static bool sz_ovl(sz_slice a, sz_slice b, size_t az, size_t bz) {
  uintptr_t a0 = (uintptr_t)a.data, b0 = (uintptr_t)b.data;
  uintptr_t a1 = a0 + (size_t)a.len * az, b1 = b0 + (size_t)b.len * bz;
  return (a0 > b0 ? a0 : b0) < (a1 < b1 ? a1 : b1);
}
static sz_slice sz_sub(sz_slice s, uint32_t a, uint32_t b, size_t es, int pos) {
  if (!(a <= b && b <= s.len)) sz_trap(2, pos);
  return (sz_slice){ (char *)s.data + (size_t)a * es, b - a };
}

// Integers: computed wide, then range-checked (T001); never C signed overflow.
/** Integer +, -, * with T001 on a result outside T (the builtin compares the exact result). */
#define SZ_AOP(op, T, a, b, pos) ({ T r_; if (__builtin_expect(__builtin_##op##_overflow((a), (b), &r_), 0)) sz_trap(1, (pos)); r_; })
#define SZ_MULI64(a, b, pos) SZ_AOP(mul, int64_t, (a), (b), (pos))
#define SZ_MULU64(a, b, pos) SZ_AOP(mul, uint64_t, (a), (b), (pos))
static int64_t sz_rng(int64_t r, int64_t lo, int64_t hi, int pos) { if (__builtin_expect(r < lo || r > hi, 0)) sz_trap(1, pos); return r; }
/** divTrunc / rem in T: T007 on a zero divisor; for signed T, x / -1 is a checked negation (MIN / -1 is T001) and x % -1 is 0. */
#define SZ_DIV(T, a, b, pos) ({ T a_ = (a), b_ = (b); if (__builtin_expect(b_ == 0, 0)) sz_trap(7, (pos)); ((T)-1 < 0 && b_ == (T)-1) ? SZ_AOP(sub, T, (T)0, a_, (pos)) : (T)(a_ / b_); })
#define SZ_REM(T, a, b, pos) ({ T a_ = (a), b_ = (b); if (__builtin_expect(b_ == 0, 0)) sz_trap(7, (pos)); ((T)-1 < 0 && b_ == (T)-1) ? (T)0 : (T)(a_ % b_); })
static int64_t sz_wrap(int64_t r, int64_t lo, int64_t hi) { int64_t m = hi - lo + 1; return ((r - lo) % m + m) % m + lo; }
static int64_t sz_wmul32(int64_t a, int64_t b, int64_t lo, int64_t hi) { return sz_wrap((int64_t)(uint32_t)((uint32_t)a * (uint32_t)b), lo, hi); }
static uint32_t sz_amt(int64_t n, int pos) { if (n < 0 || n > 31) sz_trap(9, pos); return (uint32_t)n; }
static uint32_t sz_amt64(uint64_t n, int pos) { if (n > 63ULL) sz_trap(9, pos); return (uint32_t)n; }
/** i32(x) etc. from a floating value: integral and in range, else T003. */
static int64_t sz_cvt(double x, int64_t lo, int64_t hi, int pos) { if (!(x >= (double)lo && x <= (double)hi) || x != trunc(x)) sz_trap(3, pos); return (int64_t)x; }
static int64_t sz_cvt_i64(double x, int pos) { if (!(x >= -9223372036854775808.0 && x < 9223372036854775808.0) || x != trunc(x)) sz_trap(3, pos); return (int64_t)x; }
static uint64_t sz_cvt_u64(double x, int pos) { if (!(x >= 0.0 && x < 18446744073709551616.0) || x != trunc(x)) sz_trap(3, pos); return (uint64_t)x; }
static int64_t sz_cvti(int64_t x, int64_t lo, int64_t hi, int pos) { if (x < lo || x > hi) sz_trap(3, pos); return x; }
static int64_t sz_cvtu(uint64_t x, uint64_t hi, int pos) { if (x > hi) sz_trap(3, pos); return (int64_t)x; }
static uint64_t sz_cvti_u64(int64_t x, int pos) { if (x < 0) sz_trap(3, pos); return (uint64_t)x; }

// Math with JS semantics (§10.1).
static double sz_round(double x) {
  if (isnan(x) || isinf(x)) return x;
  double r = floor(x); if (x - r >= 0.5) r += 1;
  return r == 0 && (x < 0 || signbit(x)) ? -0.0 : r;
}
static double sz_min(double a, double b) { if (isnan(a) || isnan(b)) return NAN; if (a == b) return signbit(a) ? a : b; return a < b ? a : b; }
static double sz_max(double a, double b) { if (isnan(a) || isnan(b)) return NAN; if (a == b) return signbit(a) ? b : a; return a > b ? a : b; }
static double sz_sign(double x) { return isnan(x) ? x : x > 0 ? 1 : x < 0 ? -1 : x; }
static inline bool sz_isfinite(double x) { return !isnan(x) && !isinf(x); }
static inline bool sz_isnan(double x) { return isnan(x); }
static inline bool sz_isint(double x) { return !isnan(x) && !isinf(x) && trunc(x) == x; }


// §14.4 / §14.5: a raw C pointer crossing the JS boundary is a BigInt of its address.
// Managed code can hold a CHandle (in a local, a Struct field, an OwnedCell) but cannot
// make one, so this only has to round-trip losslessly.
static void *sz_ptr_in(napi_value v) {
  uint64_t x; bool lossless;
  if (napi_get_value_bigint_uint64(sz_env, v, &x, &lossless) != napi_ok || !lossless) sz_fail("bad pointer value");
  return (void *)(uintptr_t)x;
}
static napi_value sz_ptr_out(void *p) {
  napi_value r; SZ_OK(napi_create_bigint_uint64(sz_env, (uint64_t)(uintptr_t)p, &r)); return r;
}
// §14.4 (Q209): a ring endpoint inside a box keeps its SharedArrayBuffer alive through a
// napi_ref created on the JS thread during the box call; the ref stands in the stored
// descriptor's obj slot until unbox. Verified by experiment (D123): the buffer survives
// GC with no JS handle left, the raw data pointer stays valid in later calls, and
// deleting the ref at unbox makes the buffer collectable again.
static napi_value sz_box_ref(napi_value obj) {
  napi_ref r;
  if (napi_create_reference(sz_env, obj, 1, &r) != napi_ok) sz_fail("box: cannot keep the value alive");
  return (napi_value)(uintptr_t)(void *)r;
}
static napi_value sz_box_unref(napi_value fake) {
  napi_ref r = (napi_ref)(uintptr_t)(const void *)fake;
  napi_value v;
  if (napi_get_reference_value(sz_env, r, &v) != napi_ok) sz_fail("unbox: the boxed value is gone");
  napi_delete_reference(sz_env, r);
  return v;
}

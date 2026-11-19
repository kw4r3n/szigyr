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

typedef struct { napi_value obj; void *data; uint32_t len, cap, esize; napi_typedarray_type tt; } sts_vec;
typedef struct { void *data; uint32_t len; } sts_slice;
typedef struct { uint32_t pool, gen, idx; } sts_handle; // a Pool handle: three u32s, 12 bytes (Q188 (a))
typedef struct { bool some; } sts_null; // a value of type `null`: never present, so `x === null` reads `!x.some` as for `T | null`

static _Thread_local napi_env sts_env;
static _Thread_local napi_ref sts_host; // { trap(code, file, line, col), create(alloc, cap, elem) }
static _Thread_local jmp_buf sts_jb;
static _Thread_local int sts_trap_code, sts_trap_pos, sts_depth;
static _Thread_local const char *sts_err; // internal (non-trap) error message

// The program's end flag and the first trap (SPEC 14.6 / 15.4): one flag per program,
// shared by every thread. It is set when any thread traps and when main ends. The first
// trap to claim the record is the one reported trap; later claims are discarded. The
// record is written before the flag is stored, under the same mutex, so a reader that
// sees the flag up can take the record.
static _Atomic int sts_done;
static pthread_mutex_t sts_ftrap_mu = PTHREAD_MUTEX_INITIALIZER;
static int sts_ftrap_code, sts_ftrap_pos, sts_ftrap_taken;
static _Atomic int sts_ftrap_ready;
static void sts_claim_trap(int code, int pos) {
  pthread_mutex_lock(&sts_ftrap_mu);
  if (!atomic_load(&sts_ftrap_ready)) { sts_ftrap_code = code; sts_ftrap_pos = pos; sts_ftrap_taken = 0; atomic_store(&sts_ftrap_ready, 1); }
  atomic_store(&sts_done, 1);
  pthread_mutex_unlock(&sts_ftrap_mu);
}
/** Takes the recorded trap if it has not been reported yet (15.4: exactly one is reported). */
static int sts_take_ftrap(int *code, int *pos) {
  if (!atomic_load(&sts_ftrap_ready)) return 0;
  pthread_mutex_lock(&sts_ftrap_mu);
  int got = atomic_load(&sts_ftrap_ready) && !sts_ftrap_taken;
  if (got) { *code = sts_ftrap_code; *pos = sts_ftrap_pos; sts_ftrap_taken = 1; }
  pthread_mutex_unlock(&sts_ftrap_mu);
  return got;
}
static void sts_ftrap_reset(void) {
  pthread_mutex_lock(&sts_ftrap_mu);
  sts_ftrap_code = 0; sts_ftrap_pos = 0; sts_ftrap_taken = 0;
  atomic_store(&sts_ftrap_ready, 0);
  atomic_store(&sts_done, 0);
  pthread_mutex_unlock(&sts_ftrap_mu);
}

__attribute__((cold)) _Noreturn static void sts_trap(int code, int pos) { if (code >= 1) sts_claim_trap(code, pos); sts_trap_code = code; sts_trap_pos = pos; longjmp(sts_jb, 1); }
_Noreturn static void sts_fail(const char *msg) { sts_err = msg; sts_trap(0, 0); }
#define STS_OK(call) do { if ((call) != napi_ok) sts_fail(#call); } while (0)
/** Q182: calls trap T006 once the stack is within a margin of this thread's real limit, so a large frame cannot overflow it. */
static _Thread_local uintptr_t sts_stack_lim;
static void sts_stack_init(void) {
  pthread_attr_t a; void *lo; size_t n;
  if (pthread_getattr_np(pthread_self(), &a) != 0 || pthread_attr_getstack(&a, &lo, &n) != 0) sts_fail("cannot read the stack bounds");
  pthread_attr_destroy(&a);
  size_t margin = n / 8 > (size_t)256 << 10 ? n / 8 : (size_t)256 << 10;
  sts_stack_lim = (uintptr_t)lo + margin;
}
#define STS_STACK_LOW() ((uintptr_t)__builtin_frame_address(0) < sts_stack_lim)
/** A thread C created (14.6): the stack bounds come from the OS where they can be read.
 * Where they cannot, the limit is 1, which no frame address is below, so only the depth
 * limit applies (14.4's undefined behavior 10 covers a stack that is really too small). */
static void sts_tramp_stack_init(void) {
  pthread_attr_t a; void *lo; size_t n;
  if (pthread_getattr_np(pthread_self(), &a) != 0) { sts_stack_lim = 1; return; }
  int ok = pthread_attr_getstack(&a, &lo, &n) == 0;
  pthread_attr_destroy(&a);
  if (!ok) { sts_stack_lim = 1; return; }
  size_t margin = n / 8 > (size_t)256 << 10 ? n / 8 : (size_t)256 << 10;
  sts_stack_lim = (uintptr_t)lo + margin;
}

// Vec handles live until the boundary call returns; the list is reset per entry.
static _Thread_local sts_vec **sts_vecs; static _Thread_local size_t sts_nvecs, sts_capvecs;
static sts_vec *sts_vec_new(void) {
  if (sts_nvecs == sts_capvecs) { sts_capvecs = sts_capvecs ? sts_capvecs * 2 : 16; sts_vecs = realloc(sts_vecs, sts_capvecs * sizeof *sts_vecs); if (!sts_vecs) sts_fail("out of memory"); }
  sts_vec *v = calloc(1, sizeof *v); if (!v) sts_fail("out of memory");
  return sts_vecs[sts_nvecs++] = v;
}
static napi_value sts_get(napi_value o, const char *k) { napi_value r; STS_OK(napi_get_named_property(sts_env, o, k, &r)); return r; }
static void sts_set(napi_value o, const char *k, napi_value v) { STS_OK(napi_set_named_property(sts_env, o, k, v)); }
static uint32_t sts_tbytes(napi_typedarray_type tt) {
  switch (tt) { case napi_int8_array: case napi_uint8_array: return 1; case napi_int16_array: case napi_uint16_array: return 2; case napi_float64_array: return 8; default: return 4; }
}
static napi_value sts_hostf(const char *k, napi_value *host) { STS_OK(napi_get_reference_value(sts_env, sts_host, host)); return sts_get(*host, k); }
/** `esize` and `desc` come from the static element type: a number type's name or a layout's JSON (SPEC §10.2, D105). */
static void sts_vec_load(sts_vec *v, const char *desc) {
  napi_value buf = sts_get(v->obj, "buf"); bool ta;
  STS_OK(napi_is_typedarray(sts_env, buf, &ta));
  if (!ta) { // made where the element type was a type parameter (D100): switch it to its representation
    napi_value host, f = sts_hostf("adopt", &host), args[2] = { v->obj }, r;
    STS_OK(napi_create_string_utf8(sts_env, desc, NAPI_AUTO_LENGTH, &args[1])); STS_OK(napi_call_function(sts_env, host, f, 2, args, &r));
    buf = sts_get(v->obj, "buf"); STS_OK(napi_is_typedarray(sts_env, buf, &ta)); if (!ta) sts_fail("Vec is not backed by a TypedArray");
  }
  size_t n; napi_value ab; size_t off;
  STS_OK(napi_get_typedarray_info(sts_env, buf, &v->tt, &n, &v->data, &ab, &off));
  size_t cap = n * sts_tbytes(v->tt) / v->esize; v->cap = cap > UINT32_MAX ? UINT32_MAX : (uint32_t)cap;
  double len; STS_OK(napi_get_value_double(sts_env, sts_get(v->obj, "len"), &len));
  if (!(len >= 0 && len <= v->cap)) sts_fail("Vec length out of range"); v->len = (uint32_t)len;
}
static sts_vec *sts_vec_in(napi_value o, uint32_t es, const char *desc) { sts_vec *v = sts_vec_new(); v->obj = o; v->esize = es; sts_vec_load(v, desc); return v; }
/** A JS exception from the host's allocation (RangeError) is T006 at the call, as in JS (D100, Q035). */
static void sts_alloc_ok(napi_status st, int pos) {
  if (st == napi_ok) return;
  bool pend; napi_value x; if (napi_is_exception_pending(sts_env, &pend) == napi_ok && pend) napi_get_and_clear_last_exception(sts_env, &x);
  sts_trap(6, pos);
}
static sts_vec *sts_vec_create(napi_value alloc, uint32_t cap, const char *elem, uint32_t es, int pos) {
  napi_value host, f = sts_hostf("create", &host), args[3], r;
  args[0] = alloc; STS_OK(napi_create_uint32(sts_env, cap, &args[1])); STS_OK(napi_create_string_utf8(sts_env, elem, NAPI_AUTO_LENGTH, &args[2]));
  sts_alloc_ok(napi_call_function(sts_env, host, f, 3, args, &r), pos);
  return sts_vec_in(r, es, elem);
}
/** Growth keeps the length within usize: the capacity doubles up to 2^32 - 1 elements; past that, or when the allocation fails, T006 (D106). */
static void sts_vec_grow(sts_vec *v, int pos) {
  if (v->len == UINT32_MAX) sts_trap(6, pos);
  uint64_t c = (uint64_t)v->len * 2; uint32_t cap = c > UINT32_MAX ? UINT32_MAX : c < 4 ? 4 : (uint32_t)c, len = v->len;
  // through the host: napi_create_arraybuffer aborts the process when V8 is out of memory; a JS RangeError becomes T006 (D106)
  napi_value host, f = sts_hostf("reserve", &host), args[3] = { v->obj }, r;
  STS_OK(napi_create_uint32(sts_env, cap, &args[1])); STS_OK(napi_create_uint32(sts_env, len, &args[2]));
  sts_alloc_ok(napi_call_function(sts_env, host, f, 3, args, &r), pos);
  size_t n; napi_value ab, buf = sts_get(v->obj, "buf"); size_t off;
  STS_OK(napi_get_typedarray_info(sts_env, buf, &v->tt, &n, &v->data, &ab, &off));
  v->cap = cap; v->len = len;
}
/** Boundary exit: lengths changed in C go back to the JS objects. */
static void sts_vec_sync(void) {
  for (size_t i = 0; i < sts_nvecs; i++) { napi_value n; if (napi_create_uint32(sts_env, sts_vecs[i]->len, &n) == napi_ok) napi_set_named_property(sts_env, sts_vecs[i]->obj, "len", n); free(sts_vecs[i]); }
  sts_nvecs = 0;
}
// Pool handles live until the boundary call returns, like Vec handles; the list is reset per entry.
typedef struct { napi_value obj; void *data; uint32_t len, cap, esize; uint32_t *gens; uint8_t *occ; int32_t *nextFree; int64_t freeHead, nextFresh; uint32_t id; } sts_pool;
static _Thread_local sts_pool **sts_pools; static _Thread_local size_t sts_npools, sts_cappools;
static sts_pool *sts_pool_new(void) {
  if (sts_npools == sts_cappools) { sts_cappools = sts_cappools ? sts_cappools * 2 : 16; sts_pools = realloc(sts_pools, sts_cappools * sizeof *sts_pools); if (!sts_pools) sts_fail("out of memory"); }
  sts_pool *p = calloc(1, sizeof *p); if (!p) sts_fail("out of memory");
  return sts_pools[sts_npools++] = p;
}
static double sts_pnum(napi_value o, const char *k) { double d; STS_OK(napi_get_value_double(sts_env, sts_get(o, k), &d)); return d; }
static void *sts_pta(napi_value o, const char *k) { napi_value buf = sts_get(o, k); napi_typedarray_type tt; size_t n, off; napi_value ab; void *d; STS_OK(napi_get_typedarray_info(sts_env, buf, &tt, &n, &d, &ab, &off)); return d; }
/** `esize` and `desc` come from the static element type, as for Vec (SPEC §10.2, D105). */
static void sts_pool_load(sts_pool *p, const char *desc) {
  napi_value buf = sts_get(p->obj, "buf"); bool ta;
  STS_OK(napi_is_typedarray(sts_env, buf, &ta));
  if (!ta) { // made where the element type was a type parameter: switch it to its representation
    napi_value host, f = sts_hostf("adoptPool", &host), args[2] = { p->obj }, r;
    STS_OK(napi_create_string_utf8(sts_env, desc, NAPI_AUTO_LENGTH, &args[1])); STS_OK(napi_call_function(sts_env, host, f, 2, args, &r));
    buf = sts_get(p->obj, "buf"); STS_OK(napi_is_typedarray(sts_env, buf, &ta)); if (!ta) sts_fail("Pool is not backed by a TypedArray");
  }
  napi_typedarray_type tt; size_t n, off; napi_value ab;
  STS_OK(napi_get_typedarray_info(sts_env, buf, &tt, &n, &p->data, &ab, &off));
  p->gens = (uint32_t *)sts_pta(p->obj, "gens"); p->occ = (uint8_t *)sts_pta(p->obj, "occ"); p->nextFree = (int32_t *)sts_pta(p->obj, "nextFree");
  p->len = (uint32_t)sts_pnum(p->obj, "len"); p->cap = (uint32_t)sts_pnum(p->obj, "capacity");
  p->freeHead = (int64_t)sts_pnum(p->obj, "freeHead"); p->nextFresh = (int64_t)sts_pnum(p->obj, "nextFresh");
  p->id = (uint32_t)sts_pnum(p->obj, "id");
}
static sts_pool *sts_pool_in(napi_value o, uint32_t es, const char *desc) { sts_pool *p = sts_pool_new(); p->obj = o; p->esize = es; sts_pool_load(p, desc); return p; }
static sts_pool *sts_pool_create(napi_value alloc, uint32_t cap, const char *elem, uint32_t es, int pos) {
  napi_value host, f = sts_hostf("createPool", &host), args[3], r;
  args[0] = alloc; STS_OK(napi_create_uint32(sts_env, cap, &args[1])); STS_OK(napi_create_string_utf8(sts_env, elem, NAPI_AUTO_LENGTH, &args[2]));
  sts_alloc_ok(napi_call_function(sts_env, host, f, 3, args, &r), pos);
  return sts_pool_in(r, es, elem);
}
/** Boundary exit: slot bookkeeping changed in C goes back to the JS object. Element bytes and the gens / occ / nextFree arrays are shared. */
static void sts_pool_sync(void) {
  for (size_t i = 0; i < sts_npools; i++) {
    sts_pool *p = sts_pools[i]; napi_value n;
    if (napi_create_double(sts_env, (double)p->len, &n) == napi_ok) napi_set_named_property(sts_env, p->obj, "len", n);
    if (napi_create_double(sts_env, (double)p->freeHead, &n) == napi_ok) napi_set_named_property(sts_env, p->obj, "freeHead", n);
    if (napi_create_double(sts_env, (double)p->nextFresh, &n) == napi_ok) napi_set_named_property(sts_env, p->obj, "nextFresh", n);
    free(p);
  }
  sts_npools = 0;
}
static bool sts_pool_valid(sts_pool *p, sts_handle h) { return h.pool == p->id && h.idx < p->cap && p->occ[h.idx] && p->gens[h.idx] == h.gen; }
static sts_handle sts_hdl_in(napi_value o) { sts_handle h; h.pool = (uint32_t)sts_pnum(o, "pool"); h.gen = (uint32_t)sts_pnum(o, "gen"); h.idx = (uint32_t)sts_pnum(o, "idx"); return h; }
static napi_value sts_hdl_out(sts_handle h) {
  napi_value o, v; STS_OK(napi_create_object(sts_env, &o));
  STS_OK(napi_create_uint32(sts_env, h.pool, &v)); sts_set(o, "pool", v);
  STS_OK(napi_create_uint32(sts_env, h.gen, &v)); sts_set(o, "gen", v);
  STS_OK(napi_create_uint32(sts_env, h.idx, &v)); sts_set(o, "idx", v);
  return o;
}
typedef struct { uint32_t arena, gen, off, len; } sts_abuf; // an ArenaBuf: four u32s, 16 bytes (Q188 (b))
static sts_abuf sts_abuf_in(napi_value o) { sts_abuf b; b.arena = (uint32_t)sts_pnum(o, "arena"); b.gen = (uint32_t)sts_pnum(o, "gen"); b.off = (uint32_t)sts_pnum(o, "off"); b.len = (uint32_t)sts_pnum(o, "length"); return b; }
static napi_value sts_abuf_out(sts_abuf b) {
  napi_value o, v; STS_OK(napi_create_object(sts_env, &o));
  STS_OK(napi_create_uint32(sts_env, b.arena, &v)); sts_set(o, "arena", v);
  STS_OK(napi_create_uint32(sts_env, b.gen, &v)); sts_set(o, "gen", v);
  STS_OK(napi_create_uint32(sts_env, b.off, &v)); sts_set(o, "off", v);
  STS_OK(napi_create_uint32(sts_env, b.len, &v)); sts_set(o, "length", v);
  return o;
}
// Arena handles live until the boundary call returns, like Pool handles; the list is reset per entry.
typedef struct { napi_value obj; void *data; uint32_t cap, used, gen, id; uint32_t *roff; const char **rdesc; size_t nrec, caprec; } sts_arena;
static _Thread_local sts_arena **sts_arenas; static _Thread_local size_t sts_narenas, sts_caparenas;
static sts_arena *sts_arena_new(void) {
  if (sts_narenas == sts_caparenas) { sts_caparenas = sts_caparenas ? sts_caparenas * 2 : 16; sts_arenas = realloc(sts_arenas, sts_caparenas * sizeof *sts_arenas); if (!sts_arenas) sts_fail("out of memory"); }
  sts_arena *a = calloc(1, sizeof *a); if (!a) sts_fail("out of memory");
  return sts_arenas[sts_narenas++] = a;
}
static sts_arena *sts_arena_in(napi_value o) {
  sts_arena *a = sts_arena_new(); a->obj = o;
  napi_value buf = sts_get(o, "buf"); napi_typedarray_type tt; size_t n, off; napi_value ab;
  STS_OK(napi_get_typedarray_info(sts_env, buf, &tt, &n, &a->data, &ab, &off));
  a->cap = (uint32_t)n;
  a->used = (uint32_t)sts_pnum(o, "used"); a->gen = (uint32_t)sts_pnum(o, "gen"); a->id = (uint32_t)sts_pnum(o, "id");
  return a;
}
static sts_arena *sts_arena_create(napi_value alloc, uint32_t bytes, int pos) {
  napi_value host, f = sts_hostf("createArena", &host), args[2], r;
  args[0] = alloc; STS_OK(napi_create_uint32(sts_env, bytes, &args[1]));
  sts_alloc_ok(napi_call_function(sts_env, host, f, 2, args, &r), pos);
  return sts_arena_in(r);
}
/** A buf allocated in C: its offset and element kind go to the JS object at the boundary exit,
 * so a type-parameter `view` in managed code can read its bytes (D116). */
static void sts_arena_note(sts_arena *a, uint32_t off, const char *desc) {
  if (a->nrec == a->caprec) {
    size_t c = a->caprec ? a->caprec * 2 : 8;
    uint32_t *o = realloc(a->roff, c * sizeof *o); if (!o) sts_fail("out of memory"); a->roff = o;
    const char **d = realloc(a->rdesc, c * sizeof *d); if (!d) sts_fail("out of memory"); a->rdesc = d;
    a->caprec = c;
  }
  a->roff[a->nrec] = off; a->rdesc[a->nrec++] = desc;
}
/** Boundary exit: `used` and `gen` changed in C go back to the JS object, with the notes above. The bytes are shared. */
static void sts_arena_sync(void) {
  for (size_t i = 0; i < sts_narenas; i++) {
    sts_arena *a = sts_arenas[i]; napi_value n;
    if (napi_create_double(sts_env, (double)a->used, &n) == napi_ok) napi_set_named_property(sts_env, a->obj, "used", n);
    if (napi_create_double(sts_env, (double)a->gen, &n) == napi_ok) napi_set_named_property(sts_env, a->obj, "gen", n);
    napi_value f, args[2], r;
    for (size_t k = 0; k < a->nrec; k++)
      if (napi_get_named_property(sts_env, a->obj, "noteC", &f) == napi_ok && napi_create_uint32(sts_env, a->roff[k], &args[0]) == napi_ok
          && napi_create_string_utf8(sts_env, a->rdesc[k], NAPI_AUTO_LENGTH, &args[1]) == napi_ok) napi_call_function(sts_env, a->obj, f, 2, args, &r);
    free(a->roff); free(a->rdesc); free(a);
  }
  sts_narenas = 0;
}
/** Q188 (b): a buf of another arena, or one taken before `reset`, traps T012 at the member name `view`. */
static sts_slice sts_arena_view(sts_arena *a, sts_abuf b, int pos) {
  if (b.arena != a->id || b.gen != a->gen) sts_trap(12, pos);
  return (sts_slice){ (char *)a->data + b.off, b.len };
}

/** §15.1 (Q199): a ring endpoint. All state lives in the SharedArrayBuffer — the head counter at
 * byte 0, the tail counter at byte 4, the elements at byte 8 in the §10.2 layout — so there is
 * nothing to sync back at the boundary, and the positions are read and written with C11 atomics
 * (acquire / release), the same operations the JS side does with Atomics (D122). */
typedef struct { napi_value obj; uint8_t *base; uint32_t cap, esize; } sts_ring;
static sts_ring sts_ring_in(napi_value o, uint32_t es, const char *desc) {
  napi_value sab = sts_get(o, "sab");
  napi_valuetype vt; STS_OK(napi_typeof(sts_env, sab, &vt));
  if (vt == napi_null || vt == napi_undefined) { // an element type that was a type parameter: adopt its representation (D105)
    napi_value host, f = sts_hostf("adoptRing", &host), args[2] = { o }, r;
    STS_OK(napi_create_string_utf8(sts_env, desc, NAPI_AUTO_LENGTH, &args[1]));
    STS_OK(napi_call_function(sts_env, host, f, 2, args, &r));
    sab = sts_get(o, "sab");
  }
  void *data; size_t len;
  STS_OK(napi_get_arraybuffer_info(sts_env, sab, &data, &len));
  sts_ring r; r.obj = o; r.base = (uint8_t *)data; r.cap = (uint32_t)sts_pnum(o, "cap"); r.esize = es;
  return r;
}
/** The pair object { tx, rx } the host made; the caller converts its fields with sts_ring_in. */
static napi_value sts_ring_create(napi_value alloc, uint32_t cap, const char *elem, int pos) {
  if (cap == 0 || cap > 0x80000000u || (cap & (cap - 1)) != 0) sts_trap(14, pos); // T014 (§15.1)
  napi_value host, f = sts_hostf("createRing", &host), args[3], r;
  args[0] = alloc; STS_OK(napi_create_uint32(sts_env, cap, &args[1])); STS_OK(napi_create_string_utf8(sts_env, elem, NAPI_AUTO_LENGTH, &args[2]));
  sts_alloc_ok(napi_call_function(sts_env, host, f, 3, args, &r), pos);
  return r;
}
static sts_slice sts_vslice(sts_vec *v) { return (sts_slice){ v->data, v->len }; }
static sts_slice sts_slice_in(napi_value o, uint32_t es, const char *desc) {
  napi_value off; bool has; STS_OK(napi_has_named_property(sts_env, o, "off", &has));
  if (!has) { sts_vec *v = sts_vec_in(o, es, desc); return sts_vslice(v); }
  napi_value buf = sts_get(o, "buf"); bool ta; STS_OK(napi_is_typedarray(sts_env, buf, &ta));
  if (!ta) { // a view of a Vec made where the element type was a type parameter: switch both to the representation (D105)
    napi_value host, f = sts_hostf("adopt", &host), args[2] = { o }, r;
    STS_OK(napi_create_string_utf8(sts_env, desc, NAPI_AUTO_LENGTH, &args[1])); STS_OK(napi_call_function(sts_env, host, f, 2, args, &r));
    buf = sts_get(o, "buf"); STS_OK(napi_is_typedarray(sts_env, buf, &ta)); if (!ta) sts_fail("Slice is not backed by a TypedArray");
  }
  napi_typedarray_type tt; size_t n, boff; void *data; napi_value ab; STS_OK(napi_get_typedarray_info(sts_env, buf, &tt, &n, &data, &ab, &boff));
  uint32_t o32, len; off = sts_get(o, "off"); STS_OK(napi_get_value_uint32(sts_env, off, &o32)); STS_OK(napi_get_value_uint32(sts_env, sts_get(o, "length"), &len));
  // A packed view whose head is not a multiple of the element size (an Arena view, D116) carries the
  // head byte offset in the Slice's boff property, not in off; numeric views bake it into the TypedArray.
  uint32_t boff2 = 0; bool hasb; STS_OK(napi_has_named_property(sts_env, o, "boff", &hasb));
  if (hasb) boff2 = (uint32_t)sts_pnum(o, "boff");
  return (sts_slice){ (char *)data + boff2 + (size_t)o32 * es, len };
}
/** Packed element fields (SPEC §10.2). The layout aligns every field and buffers are at least 8-aligned, so the accesses are aligned.
 * They go through may_alias types: an element's bytes are read and written as different C types (a union element changes member,
 * so offset 4 may hold a float and later an int32_t), and may_alias keeps gcc from reordering those accesses (D105). */
typedef float __attribute__((may_alias)) sts_ma_float; typedef double __attribute__((may_alias)) sts_ma_double;
typedef int8_t __attribute__((may_alias)) sts_ma_int8_t; typedef uint8_t __attribute__((may_alias)) sts_ma_uint8_t;
typedef int16_t __attribute__((may_alias)) sts_ma_int16_t; typedef uint16_t __attribute__((may_alias)) sts_ma_uint16_t;
typedef int32_t __attribute__((may_alias)) sts_ma_int32_t; typedef uint32_t __attribute__((may_alias)) sts_ma_uint32_t;
#define STS_LD(T, p) (*(const sts_ma_##T *)(p))
#define STS_ST(p, T, v) (*(sts_ma_##T *)(p) = (v))
static uint32_t sts_lidx(const int32_t *tbl, uint32_t n, int32_t id) { for (uint32_t i = 0; i < n; i++) if (tbl[i] == id) return i; sts_fail("bad literal"); return 0; }
static void sts_chk(uint32_t i, uint32_t len, int pos) { if (__builtin_expect(i >= len, 0)) sts_trap(2, pos); }
/** Q190 (b): the byte ranges of two slices overlap; a zero-length range overlaps nothing. `az` / `bz`: each side's element size (arena views of different types). */
static bool sts_ovl(sts_slice a, sts_slice b, size_t az, size_t bz) {
  uintptr_t a0 = (uintptr_t)a.data, b0 = (uintptr_t)b.data;
  uintptr_t a1 = a0 + (size_t)a.len * az, b1 = b0 + (size_t)b.len * bz;
  return (a0 > b0 ? a0 : b0) < (a1 < b1 ? a1 : b1);
}
static sts_slice sts_sub(sts_slice s, uint32_t a, uint32_t b, size_t es, int pos) {
  if (!(a <= b && b <= s.len)) sts_trap(2, pos);
  return (sts_slice){ (char *)s.data + (size_t)a * es, b - a };
}

// Integers: computed wide, then range-checked (T001); never C signed overflow.
/** Integer +, -, * with T001 on a result outside T (the builtin compares the exact result). */
#define STS_AOP(op, T, a, b, pos) ({ T r_; if (__builtin_expect(__builtin_##op##_overflow((a), (b), &r_), 0)) sts_trap(1, (pos)); r_; })
static int64_t sts_rng(int64_t r, int64_t lo, int64_t hi, int pos) { if (__builtin_expect(r < lo || r > hi, 0)) sts_trap(1, pos); return r; }
static int64_t sts_mulr(int64_t a, int64_t b, int64_t lo, int64_t hi, int pos) { __int128 r = (__int128)a * b; if (__builtin_expect(r < lo || r > hi, 0)) sts_trap(1, pos); return (int64_t)r; }
/** divTrunc / rem in T: T007 on a zero divisor; for signed T, x / -1 is a checked negation (MIN / -1 is T001) and x % -1 is 0. */
#define STS_DIV(T, a, b, pos) ({ T a_ = (a), b_ = (b); if (__builtin_expect(b_ == 0, 0)) sts_trap(7, (pos)); ((T)-1 < 0 && b_ == (T)-1) ? STS_AOP(sub, T, (T)0, a_, (pos)) : (T)(a_ / b_); })
#define STS_REM(T, a, b, pos) ({ T a_ = (a), b_ = (b); if (__builtin_expect(b_ == 0, 0)) sts_trap(7, (pos)); ((T)-1 < 0 && b_ == (T)-1) ? (T)0 : (T)(a_ % b_); })
static int64_t sts_wrap(int64_t r, int64_t lo, int64_t hi) { int64_t m = hi - lo + 1; return ((r - lo) % m + m) % m + lo; }
static int64_t sts_wmul32(int64_t a, int64_t b, int64_t lo, int64_t hi) { return sts_wrap((int64_t)(uint32_t)((uint32_t)a * (uint32_t)b), lo, hi); }
static uint32_t sts_amt(int64_t n, int pos) { if (n < 0 || n > 31) sts_trap(9, pos); return (uint32_t)n; }
/** i32(x) etc. from a floating value: integral and in range, else T003. */
static int64_t sts_cvt(double x, int64_t lo, int64_t hi, int pos) { if (!(x >= (double)lo && x <= (double)hi) || x != trunc(x)) sts_trap(3, pos); return (int64_t)x; }
static int64_t sts_cvti(int64_t x, int64_t lo, int64_t hi, int pos) { if (x < lo || x > hi) sts_trap(3, pos); return x; }

// Math with JS semantics (§10.1).
static double sts_round(double x) {
  if (isnan(x) || isinf(x)) return x;
  double r = floor(x); if (x - r >= 0.5) r += 1;
  return r == 0 && (x < 0 || signbit(x)) ? -0.0 : r;
}
static double sts_min(double a, double b) { if (isnan(a) || isnan(b)) return NAN; if (a == b) return signbit(a) ? a : b; return a < b ? a : b; }
static double sts_max(double a, double b) { if (isnan(a) || isnan(b)) return NAN; if (a == b) return signbit(a) ? b : a; return a > b ? a : b; }
static double sts_sign(double x) { return isnan(x) ? x : x > 0 ? 1 : x < 0 ? -1 : x; }


// §14.4 / §14.5: a raw C pointer crossing the JS boundary is a BigInt of its address.
// Managed code can hold a CHandle (in a local, a Struct field, an OwnedCell) but cannot
// make one, so this only has to round-trip losslessly.
static void *sts_ptr_in(napi_value v) {
  uint64_t x; bool lossless;
  if (napi_get_value_bigint_uint64(sts_env, v, &x, &lossless) != napi_ok || !lossless) sts_fail("bad pointer value");
  return (void *)(uintptr_t)x;
}
static napi_value sts_ptr_out(void *p) {
  napi_value r; STS_OK(napi_create_bigint_uint64(sts_env, (uint64_t)(uintptr_t)p, &r)); return r;
}
// §14.4 (Q209): a ring endpoint inside a box keeps its SharedArrayBuffer alive through a
// napi_ref created on the JS thread during the box call; the ref stands in the stored
// descriptor's obj slot until unbox. Verified by experiment (D123): the buffer survives
// GC with no JS handle left, the raw data pointer stays valid in later calls, and
// deleting the ref at unbox makes the buffer collectable again.
static napi_value sts_box_ref(napi_value obj) {
  napi_ref r;
  if (napi_create_reference(sts_env, obj, 1, &r) != napi_ok) sts_fail("box: cannot keep the value alive");
  return (napi_value)(uintptr_t)(void *)r;
}
static napi_value sts_box_peek(napi_value fake) {
  napi_value v;
  if (napi_get_reference_value(sts_env, (napi_ref)(uintptr_t)(const void *)fake, &v) != napi_ok) sts_fail("borrow: the boxed value is gone");
  return v;
}
static napi_value sts_box_unref(napi_value fake) {
  napi_ref r = (napi_ref)(uintptr_t)(const void *)fake;
  napi_value v;
  if (napi_get_reference_value(sts_env, r, &v) != napi_ok) sts_fail("unbox: the boxed value is gone");
  napi_delete_reference(sts_env, r);
  return v;
}

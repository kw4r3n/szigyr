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

typedef struct { napi_value obj; void *data; uint32_t len, cap, esize; napi_typedarray_type tt; } sts_vec;
typedef struct { void *data; uint32_t len; } sts_slice;

static napi_env sts_env;
static napi_ref sts_host; // { trap(code, file, line, col), create(alloc, cap, elem) }
static jmp_buf sts_jb;
static int sts_trap_code, sts_trap_pos, sts_depth;
static const char *sts_err; // internal (non-trap) error message

_Noreturn static void sts_trap(int code, int pos) { sts_trap_code = code; sts_trap_pos = pos; longjmp(sts_jb, 1); }
_Noreturn static void sts_fail(const char *msg) { sts_err = msg; sts_trap(0, 0); }
#define STS_OK(call) do { if ((call) != napi_ok) sts_fail(#call); } while (0)
/** Q182: calls trap T006 once the stack is within a margin of this thread's real limit, so a large frame cannot overflow it. */
static uintptr_t sts_stack_lim;
static void sts_stack_init(void) {
  pthread_attr_t a; void *lo; size_t n;
  if (pthread_getattr_np(pthread_self(), &a) != 0 || pthread_attr_getstack(&a, &lo, &n) != 0) sts_fail("cannot read the stack bounds");
  pthread_attr_destroy(&a);
  size_t margin = n / 8 > (size_t)256 << 10 ? n / 8 : (size_t)256 << 10;
  sts_stack_lim = (uintptr_t)lo + margin;
}
#define STS_STACK_LOW() ((uintptr_t)__builtin_frame_address(0) < sts_stack_lim)

// Vec handles live until the boundary call returns; the list is reset per entry.
static sts_vec **sts_vecs; static size_t sts_nvecs, sts_capvecs;
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
  uint64_t c = (uint64_t)v->len * 2; uint32_t cap = c > UINT32_MAX ? UINT32_MAX : c < 4 ? 4 : (uint32_t)c; void *data; napi_value ab, ta;
  sts_alloc_ok(napi_create_arraybuffer(sts_env, (size_t)cap * v->esize, &data, &ab), pos);
  STS_OK(napi_create_typedarray(sts_env, v->tt, (size_t)cap * v->esize / sts_tbytes(v->tt), ab, 0, &ta));
  memcpy(data, v->data, (size_t)v->len * v->esize);
  sts_set(v->obj, "buf", ta); v->data = data; v->cap = cap;
}
/** Boundary exit: lengths changed in C go back to the JS objects. */
static void sts_vec_sync(void) {
  for (size_t i = 0; i < sts_nvecs; i++) { napi_value n; if (napi_create_uint32(sts_env, sts_vecs[i]->len, &n) == napi_ok) napi_set_named_property(sts_env, sts_vecs[i]->obj, "len", n); free(sts_vecs[i]); }
  sts_nvecs = 0;
}
static sts_slice sts_vslice(sts_vec *v) { return (sts_slice){ v->data, v->len }; }
static sts_slice sts_slice_in(napi_value o, uint32_t es, const char *desc) {
  napi_value off; bool has; STS_OK(napi_has_named_property(sts_env, o, "off", &has));
  if (!has) { sts_vec *v = sts_vec_in(o, es, desc); return sts_vslice(v); }
  napi_value buf = sts_get(o, "buf"); bool ta; STS_OK(napi_is_typedarray(sts_env, buf, &ta)); if (!ta) sts_fail("Slice of a Vec made with a type parameter as its element type (D105)");
  napi_typedarray_type tt; size_t n, boff; void *data; napi_value ab; STS_OK(napi_get_typedarray_info(sts_env, buf, &tt, &n, &data, &ab, &boff));
  uint32_t o32, len; off = sts_get(o, "off"); STS_OK(napi_get_value_uint32(sts_env, off, &o32)); STS_OK(napi_get_value_uint32(sts_env, sts_get(o, "length"), &len));
  return (sts_slice){ (char *)data + (size_t)o32 * es, len };
}
/** Packed element fields (SPEC §10.2): unaligned-safe loads and stores. */
#define STS_LD(T, p) ({ T x_; memcpy(&x_, (p), sizeof x_); x_; })
#define STS_ST(p, T, v) do { T x_ = (v); memcpy((p), &x_, sizeof x_); } while (0)
static uint32_t sts_lidx(const int32_t *tbl, uint32_t n, int32_t id) { for (uint32_t i = 0; i < n; i++) if (tbl[i] == id) return i; sts_fail("bad literal"); return 0; }
static void sts_chk(uint32_t i, uint32_t len, int pos) { if (i >= len) sts_trap(2, pos); }
static sts_slice sts_sub(sts_slice s, uint32_t a, uint32_t b, size_t es, int pos) {
  if (!(a <= b && b <= s.len)) sts_trap(2, pos);
  return (sts_slice){ (char *)s.data + (size_t)a * es, b - a };
}

// Integers: computed wide, then range-checked (T001); never C signed overflow.
static int64_t sts_rng(int64_t r, int64_t lo, int64_t hi, int pos) { if (r < lo || r > hi) sts_trap(1, pos); return r; }
static int64_t sts_mulr(int64_t a, int64_t b, int64_t lo, int64_t hi, int pos) { __int128 r = (__int128)a * b; if (r < lo || r > hi) sts_trap(1, pos); return (int64_t)r; }
static int64_t sts_div(int64_t a, int64_t b, int64_t lo, int64_t hi, int pos) { if (b == 0) sts_trap(7, pos); return sts_rng(a / b, lo, hi, pos); }
static int64_t sts_rem(int64_t a, int64_t b, int pos) { if (b == 0) sts_trap(7, pos); return a % b; }
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


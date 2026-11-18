// C runtime for the strict / rt backend (D101-D103). Included once at the top of the generated translation unit.
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

// Vec handles live until the boundary call returns; the list is reset per entry.
static sts_vec **sts_vecs; static size_t sts_nvecs, sts_capvecs;
static sts_vec *sts_vec_new(void) {
  if (sts_nvecs == sts_capvecs) { sts_capvecs = sts_capvecs ? sts_capvecs * 2 : 16; sts_vecs = realloc(sts_vecs, sts_capvecs * sizeof *sts_vecs); if (!sts_vecs) sts_fail("out of memory"); }
  sts_vec *v = calloc(1, sizeof *v); if (!v) sts_fail("out of memory");
  return sts_vecs[sts_nvecs++] = v;
}
static napi_value sts_get(napi_value o, const char *k) { napi_value r; STS_OK(napi_get_named_property(sts_env, o, k, &r)); return r; }
static void sts_set(napi_value o, const char *k, napi_value v) { STS_OK(napi_set_named_property(sts_env, o, k, v)); }
static void sts_vec_load(sts_vec *v) {
  napi_value buf = sts_get(v->obj, "buf"); bool ta;
  STS_OK(napi_is_typedarray(sts_env, buf, &ta)); if (!ta) sts_fail("Vec is not backed by a TypedArray (D100 generic Vec)");
  size_t n; napi_value ab; size_t off;
  STS_OK(napi_get_typedarray_info(sts_env, buf, &v->tt, &n, &v->data, &ab, &off));
  v->cap = (uint32_t)n;
  uint32_t len; STS_OK(napi_get_value_uint32(sts_env, sts_get(v->obj, "len"), &len)); v->len = len;
  switch (v->tt) { case napi_int8_array: case napi_uint8_array: v->esize = 1; break; case napi_int16_array: case napi_uint16_array: v->esize = 2; break;
    case napi_float64_array: v->esize = 8; break; default: v->esize = 4; }
}
static sts_vec *sts_vec_in(napi_value o) { sts_vec *v = sts_vec_new(); v->obj = o; sts_vec_load(v); return v; }
static sts_vec *sts_vec_create(napi_value alloc, uint32_t cap, const char *elem) {
  napi_value host, f, args[3], r;
  STS_OK(napi_get_reference_value(sts_env, sts_host, &host)); f = sts_get(host, "create");
  args[0] = alloc; STS_OK(napi_create_uint32(sts_env, cap, &args[1])); STS_OK(napi_create_string_utf8(sts_env, elem, NAPI_AUTO_LENGTH, &args[2]));
  STS_OK(napi_call_function(sts_env, host, f, 3, args, &r));
  return sts_vec_in(r);
}
static void sts_vec_grow(sts_vec *v) {
  uint32_t cap = v->len * 2; void *data; napi_value ab, ta;
  STS_OK(napi_create_arraybuffer(sts_env, (size_t)cap * v->esize, &data, &ab));
  STS_OK(napi_create_typedarray(sts_env, v->tt, cap, ab, 0, &ta));
  memcpy(data, v->data, (size_t)v->len * v->esize);
  sts_set(v->obj, "buf", ta); v->data = data; v->cap = cap;
}
/** Boundary exit: lengths changed in C go back to the JS objects. */
static void sts_vec_sync(void) {
  for (size_t i = 0; i < sts_nvecs; i++) { napi_value n; if (napi_create_uint32(sts_env, sts_vecs[i]->len, &n) == napi_ok) napi_set_named_property(sts_env, sts_vecs[i]->obj, "len", n); free(sts_vecs[i]); }
  sts_nvecs = 0;
}
static sts_slice sts_vslice(sts_vec *v) { return (sts_slice){ v->data, v->len }; }
static sts_slice sts_slice_in(napi_value o) {
  napi_value off; bool has; STS_OK(napi_has_named_property(sts_env, o, "off", &has));
  if (!has) { sts_vec *v = sts_vec_in(o); return sts_vslice(v); }
  napi_value buf = sts_get(o, "buf"); bool ta; STS_OK(napi_is_typedarray(sts_env, buf, &ta)); if (!ta) sts_fail("Slice is not backed by a TypedArray");
  napi_typedarray_type tt; size_t n, boff; void *data; napi_value ab; STS_OK(napi_get_typedarray_info(sts_env, buf, &tt, &n, &data, &ab, &boff));
  uint32_t o32, len; off = sts_get(o, "off"); STS_OK(napi_get_value_uint32(sts_env, off, &o32)); STS_OK(napi_get_value_uint32(sts_env, sts_get(o, "length"), &len));
  size_t es = (tt == napi_int8_array || tt == napi_uint8_array) ? 1 : (tt == napi_int16_array || tt == napi_uint16_array) ? 2 : tt == napi_float64_array ? 8 : 4;
  return (sts_slice){ (char *)data + (size_t)o32 * es, len };
}
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


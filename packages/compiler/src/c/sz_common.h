// Shared C11 numeric, slice-check, and JS-math runtime included by both sz_rt.h (Native) and sz_wasm_rt.h (Wasm).
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
#ifndef SZ_MULI64
#define SZ_MULI64(a, b, pos) SZ_AOP(mul, int64_t, (a), (b), (pos))
#endif
#ifndef SZ_MULU64
#define SZ_MULU64(a, b, pos) SZ_AOP(mul, uint64_t, (a), (b), (pos))
#endif
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

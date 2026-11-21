/* szcb_names.h: a header that defines macros with short names, like real headers do (U8, S16, ...).
 * The generated C includes it, so its own names (struct, union, nullable, function pointer and
 * pointer-pack typedefs, labels, functions) must not use these spellings. Header only. */
#ifndef SZCB_NAMES_H
#define SZCB_NAMES_H

#include <stdint.h>

#define S0 unsigned char
#define S1 unsigned char
#define U0 unsigned char
#define N0 unsigned char
#define FP0 unsigned char
#define Q0 unsigned char
#define L0 unsigned char
#define L1 unsigned char
#define F0_f unsigned char

static inline int32_t szcb_names_call(int32_t (*f)(int32_t), int32_t x) { return f(x); }

#endif

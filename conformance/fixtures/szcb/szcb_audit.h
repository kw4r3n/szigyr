/* szcb_audit.h: header-only additions to the szcb fixture (no library code), for nested
 * pointer declarators (SPEC 14.2): a const pointer to a pointer, and pointers to function pointers. */
#ifndef SZCB_AUDIT_H
#define SZCB_AUDIT_H

#include <stdint.h>

static inline int32_t szcb_cpp(int32_t *const *p) { return **p; }
static inline int32_t szcb_cppp(int32_t **const *p) { return ***p; }
static inline int32_t szcb_ppfn(int32_t (**p)(int32_t)) { return (*p)(41); }
static inline int32_t szcb_cpfn(int32_t (*const *p)(int32_t)) { return (*p)(1); }

#endif

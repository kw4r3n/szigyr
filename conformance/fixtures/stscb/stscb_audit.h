/* stscb_audit.h: header-only additions to the stscb fixture (no library code), for nested
 * pointer declarators (SPEC 14.2): a const pointer to a pointer, and pointers to function pointers. */
#ifndef STSCB_AUDIT_H
#define STSCB_AUDIT_H

#include <stdint.h>

static inline int32_t stscb_cpp(int32_t *const *p) { return **p; }
static inline int32_t stscb_cppp(int32_t **const *p) { return ***p; }
static inline int32_t stscb_ppfn(int32_t (**p)(int32_t)) { return (*p)(41); }
static inline int32_t stscb_cpfn(int32_t (*const *p)(int32_t)) { return (*p)(1); }

#endif

// Randomised check of the Wasm linear-memory allocator in sz_wasm_rt.h.
// A shadow table records every live allocation; contents are verified before each free / realloc,
// and the block list and free bins are walked for consistency every CHECK_EVERY steps.
#include "sz_wasm_rt.h"
// The header maps malloc / calloc / realloc / free to its own allocator; this file names the struct member `free`.
#undef malloc
#undef calloc
#undef realloc
#undef free

#define NSLOT 2048
#define CHECK_EVERY 2000u

static void *ptrs[NSLOT];
static uint32_t sizes[NSLOT];
static uint8_t tags[NSLOT];
static uint32_t rs;
static uint32_t detail;

static uint32_t rnd(void) { rs = rs * 1664525u + 1013904223u; return rs >> 8; }

static void fill(uint32_t i) { uint8_t *p = (uint8_t *)ptrs[i]; for (uint32_t j = 0; j < sizes[i]; j++) p[j] = (uint8_t)(tags[i] + j * 7u); }
static int same(const uint8_t *p, uint8_t tag, uint32_t n) { for (uint32_t j = 0; j < n; j++) if (p[j] != (uint8_t)(tag + j * 7u)) return 0; return 1; }

static uint32_t pick(uint32_t maxsz) {
  uint32_t r = rnd() % 100u;
  if (r < 45u) return 1u + rnd() % 112u;          // exact bins
  if (r < 60u) return 16u * (1u + rnd() % 7u);     // exactly 16..112
  if (r < 85u) return 113u + rnd() % 4000u;        // range bins
  if (r < 97u) return 4096u + rnd() % 60000u;
  return rnd() % (maxsz + 1u);                     // includes 0 and large
}

// Walks the heap. Returns 0 when consistent, otherwise a code >= 100.
static int invariants(void) {
  uintptr_t base = ((uintptr_t)&__heap_base + 15u) & ~(uintptr_t)15u;
  uint32_t nfree = 0;
  sz_blk *prev = NULL;
  uintptr_t expect = base;
  for (sz_blk *b = sz_heap_head; b; b = b->next) {
    if ((uintptr_t)b != expect) return 100;                  // blocks are contiguous
    if (((uintptr_t)(b + 1)) & 15u) return 101;              // payload alignment
    if (b->size < 16u || (b->size & 15u)) return 102;
    if (b->prev != prev) return 103;
    if (b->free > 1u) return 104;
    if (b->free && prev && prev->free) return 105;           // no two adjacent free blocks
    if (b->free) nfree++;
    expect = (uintptr_t)(b + 1) + b->size;
    prev = b;
  }
  if (prev != sz_heap_tail) return 106;
  if (sz_heap_head && expect != (uintptr_t)sz_heap_cur) return 107;
  if (!sz_heap_head && sz_heap_cur && (uintptr_t)sz_heap_cur != base) return 108;
  if (sz_heap_tail && sz_heap_tail->free) return 109;        // the tail block is never free
  uint32_t inbins = 0;
  for (uint32_t k = 0; k < 32u; k++) {
    sz_blk *fp = NULL;
    uint32_t guard = 0;
    for (sz_blk *c = sz_free_bins[k]; c; c = sz_fn(c)->fnext) {
      if (!c->free) return 110;                              // only free blocks are listed
      if (sz_bin(c->size) != k) return 111;                  // in the right bin
      if (sz_fn(c)->fprev != fp) return 112;
      fp = c; inbins++;
      if (++guard > 10000000u) return 113;                   // cycle
    }
    uint32_t bit = (sz_free_mask >> k) & 1u;
    if (bit != (sz_free_bins[k] ? 1u : 0u)) return 114;      // mask matches bins
  }
  if (inbins != nfree) return 115;                           // every free block is listed exactly once
  return 0;
}

SZ_EXP(fuzz_detail) uint32_t fuzz_detail(void) { return detail; }

SZ_EXP(fuzz) int fuzz(uint32_t seed, uint32_t steps, uint32_t maxsz) {
  rs = seed;
  for (uint32_t i = 0; i < NSLOT; i++) ptrs[i] = NULL;
  for (uint32_t s = 0; s < steps; s++) {
    detail = s;
    uint32_t i = rnd() % NSLOT, op = rnd() % 100u;
    if (!ptrs[i]) {
      uint32_t n = pick(maxsz);
      void *p = (op < 10u) ? sz_calloc(1, n) : sz_malloc(n);
      if (!p) return 1;
      if (((uintptr_t)p) & 15u) return 2;
      if (op < 10u) { for (uint32_t j = 0; j < n; j++) if (((uint8_t *)p)[j]) return 3; }
      ptrs[i] = p; sizes[i] = n; tags[i] = (uint8_t)rnd(); fill(i);
    } else if (op < 55u) {
      if (!same((uint8_t *)ptrs[i], tags[i], sizes[i])) return 4;
      sz_free(ptrs[i]); ptrs[i] = NULL;
    } else {
      if (!same((uint8_t *)ptrs[i], tags[i], sizes[i])) return 5;
      uint32_t n = pick(maxsz);
      void *q = sz_realloc(ptrs[i], n);
      if (!q) return 6;
      if (((uintptr_t)q) & 15u) return 7;
      uint32_t m = sizes[i] < n ? sizes[i] : n;
      if (!same((uint8_t *)q, tags[i], m)) return 8;
      ptrs[i] = q; sizes[i] = n; tags[i] = (uint8_t)rnd(); fill(i);
    }
    if (s % CHECK_EVERY == 0u) { int r = invariants(); if (r) return r; }
  }
  int r = invariants(); if (r) return r;
  for (uint32_t i = 0; i < NSLOT; i++) if (ptrs[i]) {
    if (!same((uint8_t *)ptrs[i], tags[i], sizes[i])) return 9;
    sz_free(ptrs[i]); ptrs[i] = NULL;
    if ((i & 255u) == 0u) { r = invariants(); if (r) return r; }
  }
  if (sz_heap_head || sz_heap_tail || sz_free_mask) return 10;    // everything returned
  return invariants();
}

// Many allocations with no frees: returns the number of blocks the allocator had to touch is not observable,
// so the caller times this from JS.
SZ_EXP(burst) uint32_t burst(uint32_t n, uint32_t size) {
  uint32_t ok = 0;
  void **keep = (void **)sz_malloc(n * sizeof(void *));
  if (!keep) return 0;
  for (uint32_t i = 0; i < n; i++) { keep[i] = sz_malloc(size); if (keep[i]) ok++; }
  for (uint32_t i = 0; i < n; i++) sz_free(keep[i]);
  sz_free(keep);
  return ok;
}

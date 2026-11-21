/* szcb: a tiny C fixture library for the Szigyr conformance suite (stage 3-6, SPEC 14.6 / 15.4).
 * It calls a Szigyr callback (a `cfn` trampoline) from its own threads so the suite can observe
 * foreign-thread traps. No external dependencies beyond libc and pthread. */
#ifndef SZCB_H
#define SZCB_H

#include <stddef.h>
#include <stdint.h>

/* The callback shape: a Szigyr rt function reached through `cfn` (SPEC 14.6). */
typedef int32_t (*szcb_fn)(void *ud, int32_t x);
/* A callback with a `usize` parameter and result (C `size_t`, SPEC 14.2). */
typedef size_t (*szcb_fn_sz)(void *ud, size_t n);

/* Call `f(ud, x)` here, on the caller's thread, and return its value. */
int32_t szcb_call(szcb_fn f, void *ud, int32_t x);
/* Call `f(ud, x)` on a new thread, wait for that thread, and return f's value. */
int32_t szcb_thread(szcb_fn f, void *ud, int32_t x);
/* Start one thread: after `delay_ms` milliseconds it calls `f(ud, x)`, then calls
 * `after(aud, 0)` on the same thread. `szcb_join` waits for the thread. Only one
 * started thread may be outstanding; starting again first waits for the previous
 * thread to end (a program that ended on a trap never joins). */
void szcb_start(szcb_fn f, void *ud, int32_t x, int32_t delay_ms, szcb_fn after, void *aud);
void szcb_join(void);
/* Call `f(ud, x)` and `g(gud, x)` on two new threads at the same time and wait for both. */
void szcb_race(szcb_fn f, void *ud, szcb_fn g, void *gud, int32_t x);
/* Call `f(ud, 4294967296)`: the argument does not fit in a Szigyr `usize`, so the
 * trampoline traps T003 before f runs (SPEC 14.2). Returns f's value if it runs. */
size_t szcb_call_big(szcb_fn_sz f, void *ud);

/* A fixture-owned i32 cell a callback can read and write through its userdata pointer,
 * so a test can observe how many times the callback body actually ran. */
int32_t *szcb_cell(void);
/* Statistics: how many times the fixture invoked a callback (szcb_call, szcb_thread,
 * szcb_start's f and after, szcb_race's f and g, szcb_call_big), and the i32 values
 * callbacks returned to the fixture, in order (at most 16 are kept). */
void szcb_reset_stats(void);
int32_t szcb_stat_n(void);
int32_t szcb_stat(int32_t i);

#endif

/* stscb: a tiny C fixture library for the Szigyr conformance suite (stage 3-6, SPEC 14.6 / 15.4).
 * It calls an STS callback (a `cfn` trampoline) from its own threads so the suite can observe
 * foreign-thread traps. No external dependencies beyond libc and pthread. */
#ifndef STSCB_H
#define STSCB_H

#include <stddef.h>
#include <stdint.h>

/* The callback shape: an STS rt function reached through `cfn` (SPEC 14.6). */
typedef int32_t (*stscb_fn)(void *ud, int32_t x);
/* A callback with a `usize` parameter and result (C `size_t`, SPEC 14.2). */
typedef size_t (*stscb_fn_sz)(void *ud, size_t n);

/* Call `f(ud, x)` here, on the caller's thread, and return its value. */
int32_t stscb_call(stscb_fn f, void *ud, int32_t x);
/* Call `f(ud, x)` on a new thread, wait for that thread, and return f's value. */
int32_t stscb_thread(stscb_fn f, void *ud, int32_t x);
/* Start one thread: after `delay_ms` milliseconds it calls `f(ud, x)`, then calls
 * `after(aud, 0)` on the same thread. `stscb_join` waits for the thread. Only one
 * started thread may be outstanding; starting again first waits for the previous
 * thread to end (a program that ended on a trap never joins). */
void stscb_start(stscb_fn f, void *ud, int32_t x, int32_t delay_ms, stscb_fn after, void *aud);
void stscb_join(void);
/* Call `f(ud, x)` and `g(gud, x)` on two new threads at the same time and wait for both. */
void stscb_race(stscb_fn f, void *ud, stscb_fn g, void *gud, int32_t x);
/* Call `f(ud, 4294967296)`: the argument does not fit in an STS `usize`, so the
 * trampoline traps T003 before f runs (SPEC 14.2). Returns f's value if it runs. */
size_t stscb_call_big(stscb_fn_sz f, void *ud);

/* A fixture-owned i32 cell a callback can read and write through its userdata pointer,
 * so a test can observe how many times the callback body actually ran. */
int32_t *stscb_cell(void);
/* Statistics: how many times the fixture invoked a callback (stscb_call, stscb_thread,
 * stscb_start's f and after, stscb_race's f and g, stscb_call_big), and the i32 values
 * callbacks returned to the fixture, in order (at most 16 are kept). */
void stscb_reset_stats(void);
int32_t stscb_stat_n(void);
int32_t stscb_stat(int32_t i);

#endif

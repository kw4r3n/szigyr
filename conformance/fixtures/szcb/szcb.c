#include "szcb.h"

#include <pthread.h>
#include <stdlib.h>
#include <time.h>

static int32_t the_cell;
int32_t *szcb_cell(void) { return &the_cell; }

static int32_t stat_values[16];
static int stat_count;
void szcb_reset_stats(void) { stat_count = 0; }
int32_t szcb_stat_n(void) { return stat_count; }
int32_t szcb_stat(int32_t i) { return i >= 0 && i < stat_count && i < 16 ? stat_values[i] : 0; }
static void note(int32_t v) {
  if (stat_count < 16) stat_values[stat_count] = v;
  stat_count++;
}

int32_t szcb_call(szcb_fn f, void *ud, int32_t x) {
  int32_t r = f(ud, x);
  note(r);
  return r;
}

struct call_args { szcb_fn f; void *ud; int32_t x; int32_t r; };
static void *call_main(void *p) {
  struct call_args *a = p;
  a->r = a->f(a->ud, a->x);
  return NULL;
}
int32_t szcb_thread(szcb_fn f, void *ud, int32_t x) {
  struct call_args a = { f, ud, x, 0 };
  pthread_t t;
  if (pthread_create(&t, NULL, call_main, &a) != 0) return szcb_call(f, ud, x);
  pthread_join(t, NULL);
  note(a.r);
  return a.r;
}

static pthread_t started;
static int started_live;
struct start_args { szcb_fn f; void *ud; int32_t x; int32_t delay_ms; szcb_fn after; void *aud; };
static void *start_main(void *p) {
  struct start_args *a = p;
  if (a->delay_ms > 0) {
    struct timespec ts = { a->delay_ms / 1000, (long)(a->delay_ms % 1000) * 1000000L };
    nanosleep(&ts, NULL);
  }
  int32_t r = a->f(a->ud, a->x);
  note(r);
  int32_t r2 = a->after(a->aud, 0);
  note(r2);
  free(a);
  return NULL;
}
void szcb_start(szcb_fn f, void *ud, int32_t x, int32_t delay_ms, szcb_fn after, void *aud) {
  if (started_live) { pthread_join(started, NULL); started_live = 0; } // a caller that never joined (its program ended on the trap) must not wedge the fixture
  struct start_args *a = malloc(sizeof *a);
  if (!a) return;
  *a = (struct start_args){ f, ud, x, delay_ms, after, aud };
  if (pthread_create(&started, NULL, start_main, a) != 0) { free(a); return; }
  started_live = 1;
}
void szcb_join(void) {
  if (!started_live) return;
  pthread_join(started, NULL);
  started_live = 0;
}

void szcb_race(szcb_fn f, void *ud, szcb_fn g, void *gud, int32_t x) {
  struct call_args a = { f, ud, x, 0 }, b = { g, gud, x, 0 };
  pthread_t ta, tb;
  int oka = pthread_create(&ta, NULL, call_main, &a) == 0;
  int okb = pthread_create(&tb, NULL, call_main, &b) == 0;
  if (oka) pthread_join(ta, NULL);
  if (okb) pthread_join(tb, NULL);
  note(a.r);
  note(b.r);
}

size_t szcb_call_big(szcb_fn_sz f, void *ud) {
  size_t r = f(ud, (size_t)4294967296ULL);
  note((int32_t)r);
  return r;
}

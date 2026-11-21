// Hand-written C for the kernels in bench/kernels.ts: same data, same arithmetic, no bounds or range checks.
// Built by bench/run.ts with the C backend's flags (minus -shared -fPIC).
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

#define N 1048576u
#define REPS 50
typedef struct { float x, y, vx, vy; } P;

static double now_ms(void) { struct timespec t; clock_gettime(CLOCK_REALTIME, &t); return t.tv_sec * 1e3 + t.tv_nsec / 1e6; }
// noipa: like the Szigyr kernels, each call is a real call the compiler cannot hoist out of the timing loop
__attribute__((noipa)) static float dot(const float *a, const float *b, uint32_t n) { float acc = 0; for (uint32_t i = 0; i < n; i++) acc += a[i] * b[i]; return acc; }
__attribute__((noipa)) static void saxpy(float k, const float *x, float *y, uint32_t n) { for (uint32_t i = 0; i < n; i++) y[i] = k * x[i] + y[i]; }
__attribute__((noipa)) static int32_t prefix(int32_t *s, uint32_t n) { for (uint32_t i = 1; i < n; i++) s[i] = s[i] + s[i - 1]; return s[n - 1]; }
__attribute__((noipa)) static void reset_i32(int32_t *s, uint32_t n) { for (uint32_t i = 0; i < n; i++) s[i] = (int32_t)(i % 3); }
__attribute__((noipa)) static double stencil(const double *a, double *out, uint32_t n) { for (uint32_t i = 1; i + 1 < n; i++) out[i] = (a[i - 1] + a[i] + a[i + 1]) / 3; return out[n / 2]; }
__attribute__((noipa)) static float particles(P *ps, uint32_t n, float dt) {
  float e = 0;
  for (uint32_t i = 0; i < n; i++) { P p = ps[i]; float vy = p.vy - 9.75f * dt; ps[i] = (P){ p.x + p.vx * dt, p.y + vy * dt, p.vx, vy }; e += vy * vy; }
  return e;
}

int main(void) {
  float *a = malloc(N * 4), *b = malloc(N * 4), *y = malloc(N * 4);
  int32_t *s = malloc(N * 4);
  double *d = malloc(N * 8), *o = malloc(N * 8);
  P *ps = malloc(N * sizeof(P));
  for (uint32_t i = 0; i < N; i++) {
    a[i] = (float)(i % 7) * 0.5f; b[i] = (float)(i % 5) * 0.5f; y[i] = (float)(i % 3) * 0.5f;
    s[i] = (int32_t)(i % 3); d[i] = (double)(i % 11) * 0.25; o[i] = d[i];
    float f = (float)(i % 13); ps[i] = (P){ f, f * 2, 1, f * 0.5f };
  }
  double sum = 0, t0;
  t0 = now_ms(); for (int r = 0; r < REPS; r++) sum = dot(a, b, N); printf("dot_f32 %.17g %.17g\n", (now_ms() - t0) / REPS, sum);
  t0 = now_ms(); for (int r = 0; r < REPS; r++) saxpy(0.5f, a, y, N); printf("saxpy_f32 %.17g %.17g\n", (now_ms() - t0) / REPS, (double)y[N - 1]);
  t0 = now_ms(); for (int r = 0; r < REPS; r++) { reset_i32(s, N); sum = prefix(s, N); } printf("prefix_i32 %.17g %.17g\n", (now_ms() - t0) / REPS, sum);
  t0 = now_ms(); for (int r = 0; r < REPS; r++) sum = stencil(d, o, N); printf("stencil_f64 %.17g %.17g\n", (now_ms() - t0) / REPS, sum);
  t0 = now_ms(); for (int r = 0; r < REPS; r++) sum = particles(ps, N, 0.001f); printf("particles_aos_f32 %.17g %.17g\n", (now_ms() - t0) / REPS, sum);
  return 0;
}

// MPFR oracle for DetMath (Q191): reads lines "<fn> <hexbits x> [<hexbits y>]" on stdin,
// writes "<hexbits result>" per line. Precision 53, MPFR_RNDN: the correctly rounded value.
// Test-only tool (scripts/detmath-oracle.ts); libmpfr is not a runtime dependency (DECISIONS).
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <mpfr.h>

static double fromBits(uint64_t b) { double d; memcpy(&d, &b, 8); return d; }
static uint64_t toBits(double d) { uint64_t b; memcpy(&b, &d, 8); return b; }

int main(void) {
  char fn[16]; unsigned long long xb, yb;
  char line[128];
  while (fgets(line, sizeof line, stdin)) {
    int n = sscanf(line, "%15s %llx %llx", fn, &xb, &yb);
    if (n < 2) continue;
    double x = fromBits((uint64_t)xb), y = n >= 3 ? fromBits((uint64_t)yb) : 0.0;
    mpfr_t mx, my, mr;
    mpfr_init2(mx, 53); mpfr_init2(my, 53); mpfr_init2(mr, 53);
    mpfr_set_d(mx, x, MPFR_RNDN);
    mpfr_set_d(my, y, MPFR_RNDN);
    int ok = 1;
    if (!strcmp(fn, "sin")) mpfr_sin(mr, mx, MPFR_RNDN);
    else if (!strcmp(fn, "cos")) mpfr_cos(mr, mx, MPFR_RNDN);
    else if (!strcmp(fn, "tan")) mpfr_tan(mr, mx, MPFR_RNDN);
    else if (!strcmp(fn, "atan")) mpfr_atan(mr, mx, MPFR_RNDN);
    else if (!strcmp(fn, "exp")) mpfr_exp(mr, mx, MPFR_RNDN);
    else if (!strcmp(fn, "log")) mpfr_log(mr, mx, MPFR_RNDN);
    else if (!strcmp(fn, "log10")) mpfr_log10(mr, mx, MPFR_RNDN);
    else if (!strcmp(fn, "tanh")) mpfr_tanh(mr, mx, MPFR_RNDN);
    else if (!strcmp(fn, "atan2")) mpfr_atan2(mr, my, mx, MPFR_RNDN);
    else if (!strcmp(fn, "pow")) mpfr_pow(mr, mx, my, MPFR_RNDN);
    else ok = 0;
    if (ok) {
      double r = mpfr_get_d(mr, MPFR_RNDN);
      printf("%016llx\n", (unsigned long long)toBits(r));
      fflush(stdout);
    }
    mpfr_clear(mx); mpfr_clear(my); mpfr_clear(mr);
  }
  return 0;
}

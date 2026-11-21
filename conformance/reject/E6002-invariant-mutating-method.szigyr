// expect: E6002 @ 7:17
// stage: 1
// open-question: Q134
function f(m: Map<string, i32>): void {
  let i: i32 = 0;
  while (i < 2) {
    invariant(m.delete("a") || true);
    i += 1;
  }
}

// expect: E6002 @ 6:22
// stage: 3
// open-question: Q230
function w(port: Port<i32, i32>): void {}
function f(sys: System): i32 {
  requires(sys.spawn.isolate(w) === null);
  return 1;
}

// expect: E6002 @ 5:17
// stage: 3
// open-question: Q230
function f(port: Port<i32, i32>): i32 {
  requires(port.close() === null);
  return 1;
}

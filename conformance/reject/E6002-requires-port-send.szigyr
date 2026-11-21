// expect: E6002 @ 5:17
// stage: 3
// open-question: Q230
function f(port: Port<i32, i32>): i32 {
  requires(port.send(1) === null);
  return 1;
}

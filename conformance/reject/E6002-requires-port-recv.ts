// expect: E6002 @ 5:24
// stage: 3
// open-question: Q230
async function f(port: Port<i32, i32>): Promise<i32> {
  requires((await port.recv()) !== null);
  return 1;
}

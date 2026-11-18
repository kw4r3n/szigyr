// expect: E6002 @ 5:13
// stage: 1
// open-question: Q134
function f(x: i32): i32 {
  requires((x = 7) === 7);
  return x;
}

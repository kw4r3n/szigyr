// expect: E4005 @ 9:10
// stage: 2
// open-question: Q046
function f(n: u32): u32 {
  "use rt";
  if (n === 0) {
    return 0;
  }
  return f(n - 1);
}

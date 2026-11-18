// expect: E4005 @ 9:10
// stage: 2
// open-question: Q046
function a(n: u32): u32 {
  "use rt";
  if (n === 0) {
    return 0;
  }
  return b(n - 1);
}
function b(n: u32): u32 {
  "use rt";
  return c(n);
}
function c(n: u32): u32 {
  "use rt";
  return a(n);
}

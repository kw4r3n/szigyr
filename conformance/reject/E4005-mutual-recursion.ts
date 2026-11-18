// expect: E4005 @ 9:10
// stage: 2
// open-question: Q046
function isEven(n: u32): boolean {
  "use rt";
  if (n === 0) {
    return true;
  }
  return isOdd(n - 1);
}
function isOdd(n: u32): boolean {
  "use rt";
  if (n === 0) {
    return false;
  }
  return isEven(n - 1);
}

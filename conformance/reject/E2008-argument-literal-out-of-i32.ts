// expect: E2008 @ 7:12
// stage: 1
function g(a: i32): i32 {
  return a;
}
function f(): i32 {
  return g(3000000000);
}

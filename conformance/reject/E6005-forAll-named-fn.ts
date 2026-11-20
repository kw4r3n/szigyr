// expect: E6005 @ 5:10
// stage: 4
function f(x: i32, a: Alloc): void {}
test("t", (t: Test) => {
  forAll(f);
});

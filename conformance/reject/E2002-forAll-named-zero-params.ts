// expect: E2002 @ 5:10
// stage: 4
function f(): void {}
test("t", (t: Test) => {
  forAll(f);
});

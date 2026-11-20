// expect: E2002 @ 4:10
// stage: 4
test("t", (t: Test) => {
  forAll(123);
});

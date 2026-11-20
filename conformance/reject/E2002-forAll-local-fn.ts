// expect: E2002 @ 5:10
// stage: 4
test("t", (t: Test) => {
  const f = (x: i32): void => {};
  forAll(f);
});

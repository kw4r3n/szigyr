// expect: E6001 @ 6:5
// stage: 4
test("t", (t: Test) => {
  forAll((x: i32): void => {
    const y = x;
    requires(y > 0);
  });
});

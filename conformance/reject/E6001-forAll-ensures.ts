// expect: E6001 @ 5:5
// stage: 4
test("t", (t: Test) => {
  forAll((x: i32): void => {
    ensures(() => true);
  });
});

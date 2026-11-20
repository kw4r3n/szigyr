// expect: E6002 @ 5:14
// stage: 4
test("t", (t: Test) => {
  forAll((x: i32): void => {
    requires(forAll((y: i32) => {}));
  });
});

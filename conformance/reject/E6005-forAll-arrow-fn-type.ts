// expect: E6005 @ 4:14
// stage: 4
test("t", (t: Test) => {
  forAll((f: (x: i32) => i32) => {});
});

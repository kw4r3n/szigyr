// expect: E2002 @ 4:3
// stage: 4
test("t", (t: Test) => {
  forAll((x: i32) => {}, 1);
});

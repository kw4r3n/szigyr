// expect: E2002 @ 4:10
// stage: 4
test("t", (t: Test) => {
  forAll((x: i32): i32 => x);
});

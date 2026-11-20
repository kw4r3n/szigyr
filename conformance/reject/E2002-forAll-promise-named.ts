// expect: E2002 @ 5:10
// stage: 4
async function f(x: i32): Promise<void> {}
test("t", (t: Test) => {
  forAll(f);
});

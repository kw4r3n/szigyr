// expect: E6001 @ 5:3
// stage: 1
// open-question: Q057
test("t", (t: Test) => {
  requires(true);
  t.ok(true);
});

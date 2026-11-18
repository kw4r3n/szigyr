// expect: E2002 @ 5:11
// stage: 1
// open-question: Q058
test("traps", (t: Test) => {
  t.traps("T999", () => {});
});

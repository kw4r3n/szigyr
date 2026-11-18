// expect: E2002 @ 6:11
// stage: 1
// open-question: Q058
test("traps", (t: Test) => {
  const code = "T002";
  t.traps(code, () => {});
});

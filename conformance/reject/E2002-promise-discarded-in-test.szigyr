// expect: E2002 @ 8:3
// stage: 1
// open-question: Q125
async function h(): Promise<void> {
  panic("x");
}
test("t", (t: Test) => {
  h();
  t.ok(true);
});

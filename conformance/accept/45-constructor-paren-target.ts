// expect: ok
// stage: 1
// open-question: Q133
class A {
  readonly f: string | null;
  constructor() {
    (this.f) = null;
  }
}
test("a parenthesized target initializes the field", (t: Test) => {
  t.ok(new A().f === null);
});

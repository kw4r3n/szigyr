// expect: E6003 @ 4:3
// stage: 1
export function f(): void {
  test("inner", (t: Test) => {
    t.ok(true);
  });
}

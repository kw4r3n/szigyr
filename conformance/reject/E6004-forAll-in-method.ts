// expect: E6004 @ 5:5
// stage: 4
class C {
  m(): void {
    forAll((x: i32) => {});
  }
}

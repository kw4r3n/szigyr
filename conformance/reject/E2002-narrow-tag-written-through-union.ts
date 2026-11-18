// expect: E2002 @ 6:5
// stage: 1
// open-question: Q122
type S = { kind: "a"; x: string } | { kind: "b"; y: i32 };
function flip(s: S): void {
  s.kind = "b";
}

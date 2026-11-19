// expect: E4007 @ 3:32
// stage: 3
export function f(p: Ptr<CType<"1bad">>): void {
  "use owned";
  "use unsafe";
}

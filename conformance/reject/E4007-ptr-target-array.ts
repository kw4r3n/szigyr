// expect: E4007 @ 4:26
// stage: 3
// open-question: Q216
export function f(p: Ptr<Array<f32>>): void {
  "use owned";
  "use unsafe";
}

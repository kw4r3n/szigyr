// expect: E4007 @ 6:28
// stage: 3
export function f(alloc: Alloc, v: Vec<f32>): void {
  "use owned";
  "use unsafe";
  const p = Ptr.box(alloc, v);
}

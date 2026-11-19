// expect: E3007 @ 5:18
// stage: 2
// open-question: Q174
export function f(): void {
  const a: Array<{ readonly v: Vec<f32> }> = [];
}

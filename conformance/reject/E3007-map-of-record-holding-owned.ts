// expect: E3007 @ 5:24
// stage: 2
// open-question: Q174
export function f(): void {
  const m: Map<string, { readonly v: Vec<f32> }> = new Map();
}

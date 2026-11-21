// expect: E3007 @ 6:15
// stage: 2
// open-question: Q174
type Bx<T> = { readonly m: Map<string, T> };
type By<T> = Bx<T>;
function f(): By<Vec<f32>> | null {
  return null;
}

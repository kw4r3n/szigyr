// expect: E3007 @ 7:15
// stage: 2
// open-question: Q174
interface I<T> {
  get(): Promise<T>;
}
function f(i: I<Vec<f32>> | null): void {
}

// expect: E2002 @ 8:22
// stage: 1
// open-question: Q075
interface Scored {
  score(): f64;
}
type Holder<T extends Scored> = { readonly v: T };
function f(h: Holder<i32>): void {}

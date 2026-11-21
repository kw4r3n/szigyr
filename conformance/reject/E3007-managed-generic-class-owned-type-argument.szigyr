// expect: E3007 @ 6:17
// stage: 2
// open-question: Q068
class Box<T> { readonly value: T; constructor(value: T) { this.value = value; } }
function f(alloc: Alloc): usize {
  const b = new Box(Vec.create<f32>(alloc, 1));
  return b.value.length;
}

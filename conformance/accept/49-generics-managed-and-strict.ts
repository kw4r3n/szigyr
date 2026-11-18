// expect: ok
// stage: 2
// open-question: Q068
class Box<T> {
  readonly items: Array<T> = [];
  add(x: T): void { this.items.push(x); this.items.push(x); }
  get(i: usize): T { return this.items[i]; }
}
function keep<T>(x: T): Array<T> { return [x, x]; }
function take<T>(x: T): T { "use owned"; return x; }
function f(alloc: Alloc): usize {
  "use owned";
  const v: Vec<f32> = take<Vec<f32>>(Vec.create<f32>(alloc, 1));
  return v.length;
}
function g(): usize { const b = new Box<string>(); b.add("a"); return keep<i32>(1).length + b.get(0).length; }

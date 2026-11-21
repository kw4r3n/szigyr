// expect: ok
// stage: 2
// open-question: Q170
// open-question: Q172
function rd(v: Ref<Vec<f32>>): usize {
  "use owned";
  return v.length;
}
function eat(v: Vec<f32>): usize {
  "use owned";
  return v.length;
}
function mk(alloc: Alloc): Vec<f32> {
  "use owned";
  return Vec.create<f32>(alloc, 2);
}
function rd2(a: Ref<Vec<f32>>, b: Ref<Vec<f32>>): usize {
  "use owned";
  return a.length + b.length;
}
function f(alloc: Alloc): usize {
  "use owned";
  const a = mk(alloc);
  a.push(f32(a.length));
  a.push(f32(rd(a))); // Q170: an inner Ref borrow under the outer Mut receiver (Q065)
  a[rd(a) - 1] = 1;
  a[a.length - 1] = a[0];
  const n = rd2(a, a) + usize(a[rd(a) - 1]);
  let b = mk(alloc);
  const c = mk(alloc);
  b = c;
  return n + eat(a) + eat(b);
}
function g(alloc: Alloc): Vec<f32> {
  "use owned";
  let b = mk(alloc);
  const c = mk(alloc);
  eat(b);
  return (b = c);
}

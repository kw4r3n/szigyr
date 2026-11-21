// expect: ok
// stage: 3
function peek(rx: Ref<RingRx<i32>>): i32 {
  "use rt";
  return 0;
}
function sum(s: Ref<Slice<i32>>): i32 {
  "use rt";
  return s[0] + s[1];
}
export function go(alloc: Alloc, cp: ConstPtr<RingRx<i32>>, v: ConstPtr<i32>): i32 {
  "use owned";
  "use unsafe";
  const a = peek(cp.borrow());
  const b = v.read();
  const c = sum(v.slice(2));
  const d = v.offset(1).read();
  return a + b + c + d;
}

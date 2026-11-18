// expect: ok
// stage: 1
function f(b: boolean): usize {
  const g = (c: boolean) => { if (c) { return "a"; } return null; };
  const h = (c: boolean) => { if (c) { return 1; } panic("no"); };
  const v = g(b);
  const n: f64 = h(b);
  return v === null ? 0 : v.length;
}

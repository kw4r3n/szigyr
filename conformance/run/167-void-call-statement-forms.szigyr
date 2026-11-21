// expect-output: 5 10
// stage: 2
function g(v: Mut<Vec<i32>>): void { "use owned"; v.push(1); }
function h(v: Mut<Vec<i32>>): void { "use owned"; v.push(10); }
function f(v: Mut<Vec<i32>>, c: boolean): void {
  "use owned";
  (g(v));
  c ? g(v) : h(v);
  (c ? (g(v)) : h(v));
  c ? g(v) : g(v);
  !c ? g(v) : h(v);
}
export function main(sys: System): void {
  const v = Vec.create<i32>(sys.alloc, 8);
  f(v, false);
  sys.log.info(`${v.length} ${v[1]}`);
}

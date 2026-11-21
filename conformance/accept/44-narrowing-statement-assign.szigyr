// expect: ok
// stage: 1
// open-question: Q133
class A {
  xs: Array<i32>;
  n: usize;
  constructor(ys: Array<i32>) {
    this.xs = ys.map((v: i32): i32 => { return v + 1; });
    this.n = this.xs.length;
  }
}
function lazy(x0: string | null): usize {
  let x: string | null = x0;
  if (x === null) { x = "d"; }
  return x.length;
}
function forInit(): usize {
  let x: string | null = null;
  let n: usize = 0;
  for (x = "ab"; n < 1; n += 1) { n += x.length; }
  return n;
}
function ternaryElse(x0: string | null): boolean {
  let x: string | null = x0;
  return x === null ? (x = "a") === "a" : x.length > 0;
}
test("statement assignments narrow; an arrow in the constructor may return", (t: Test) => {
  t.eq(new A([1, 2]).n, 2);
  t.eq(lazy(null), 1);
  t.eq(forInit(), 3);
  t.ok(ternaryElse("x"));
});

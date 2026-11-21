// expect: ok
// stage: 1
class A {
  readonly s: string;
  n: usize;
  static readonly k: i32 = 1;
  constructor(s: string, sink: Array<A>) {
    this.s = s;
    this.n = s.length;
    this.n = this.len();
    sink.push(this);
    const f = (): usize => this.s.length;
    this.n = f();
  }
  len(): usize {
    const g = (): usize => this.s.length;
    return g();
  }
  static make(): i32 {
    return A.k;
  }
}
function use(a: A): usize {
  if (a.s === "x") { return 0; }
  return a.len() + a.n;
}

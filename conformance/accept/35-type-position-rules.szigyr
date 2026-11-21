// expect: ok
// stage: 1
// open-question: Q028
// open-question: Q032
// open-question: Q058
// open-question: Q080
// open-question: Q081
// open-question: Q082
// open-question: Q084
// open-question: Q086
type Shape = { readonly kind: "dot" } | { readonly kind: "line"; readonly len: f64 };
type MaybeShape = Shape | null;
type Color = "red" | "green" | null;
type Opt<T> = T | null;
type Row = { readonly id: u32; readonly name: string | null; readonly tags: Array<string> };
type P2 = Struct<{ readonly x: f32; readonly y: f32 }>;
type Body = Struct<{ readonly pos: P2; pts: Vec<P2>; ok: boolean }>;

interface Scored {
  score(): f64;
}
class Item implements Scored {
  readonly s: f64;
  constructor(s: f64) {
    this.s = s;
  }
  score(): f64 {
    return this.s;
  }
}
function sum(b: Box<Item>): f64 {
  return b.v.score();
}
class Box<T extends Scored> {
  readonly v: T;
  constructor(v: T) {
    this.v = v;
  }
}

function length(s: MaybeShape): f64 {
  if (s === null) {
    return 0;
  }
  switch (s.kind) {
    case "dot":
      return 0;
    case "line":
      return s.len;
  }
}

function colorOr(c: Color): "red" | "green" {
  return c ?? "red";
}

function wrap<T>(x: T): Opt<T> {
  return x;
}

function sizes(m: Map<string, u32>, n: Map<usize, boolean>, s: Set<f64>, b: Set<boolean>): usize {
  return m.size + n.size + s.size + b.size;
}

function has(xs: Array<string>, cs: ReadonlyArray<Color>, ns: Array<usize | null>, it: Array<Item>, x: Item): boolean {
  return xs.includes("a") && cs.includes(null) && ns.includes(null) && it.includes(x);
}

function where(xs: ReadonlyArray<f64>): usize | null {
  return xs.indexOf(1);
}

async function later(): Promise<void> {}

function twice(f: () => void): void {
  f();
  f();
}

function parse(x: unknown): Result<Array<Row>, CastError> {
  return cast<Array<Row>>(x);
}

function show(r: Row): string {
  return JSON.stringify(r);
}

function scopes(n: i32): i32 {
  {
    const k: i32 = 1;
  }
  {
    const k: i32 = 2;
  }
  switch (n) {
    case 1: {
      const k: i32 = 3;
      return k;
    }
    default: {
      const k = n;
      return k;
    }
  }
}

test("traps", (t: Test) => {
  t.traps("T002", () => {
    const a: Array<i32> = [];
    const v: i32 = a[0];
  });
});

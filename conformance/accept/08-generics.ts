// expect: ok
// stage: 1
// open-question: Q030
// open-question: Q049
interface Scored {
  score(): f64;
}

interface Source<T> {
  next(): T;
}

class Player implements Scored {
  readonly pts: f64;

  constructor(pts: f64) {
    this.pts = pts;
  }

  score(): f64 {
    return this.pts;
  }
}

class Counter implements Source<u32> {
  private n: u32;

  constructor(start: u32) {
    this.n = start;
  }

  next(): u32 {
    this.n += 1;
    return this.n;
  }
}

type Pair<A, B> = { readonly first: A; readonly second: B };

export function totalScore<T extends Scored>(xs: ReadonlyArray<T>): f64 {
  let s: f64 = 0;
  for (const x of xs) {
    s += x.score();
  }
  return s;
}

export function identity<T>(x: T): T {
  return x;
}

export function mapArr<T, U>(xs: ReadonlyArray<T>, f: (x: T) => U): Array<U> {
  return xs.map(f);
}

test("generics", (t: Test) => {
  const ps: Array<Player> = [new Player(1), new Player(2.5)];
  t.eq(totalScore(ps), 3.5);
  t.eq(identity<i32>(5), 5);
  t.eq(mapArr(["a", "bb"], (s: string) => s.length), [1, 2]);
  const p: Pair<i32, string> = { first: 1, second: "a" };
  t.eq(p.second, "a");
  const src: Source<u32> = new Counter(0);
  t.eq(src.next(), 1);
  t.eq(src.next(), 2);
});

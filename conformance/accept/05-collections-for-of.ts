// expect: ok
// stage: 1
// open-question: Q054
const PRIMES: ReadonlyArray<u32> = [2, 3, 5, 7];

export function sumPrimes(): u32 {
  let s: u32 = 0;
  for (const p of PRIMES) {
    s += p;
  }
  return s;
}

export function sum(xs: ReadonlyArray<i32>): i32 {
  let total: i32 = 0;
  for (const x of xs) {
    total += x;
  }
  return total;
}

export function wordCounts(words: Array<string>): Map<string, usize> {
  const m = new Map<string, usize>();
  const zero: usize = 0;
  for (const w of words) {
    const c = m.get(w) ?? zero;
    m.set(w, c + 1);
  }
  return m;
}

export function totalCount(m: Map<string, usize>): usize {
  let n: usize = 0;
  for (const v of m.values()) {
    n += v;
  }
  return n;
}

export function keysJoined(m: Map<string, usize>): string {
  let out = "";
  for (const k of m.keys()) {
    out = `${out}${k};`;
  }
  return out;
}

export function uniqueCount(xs: ReadonlyArray<string>): usize {
  const s = new Set<string>();
  for (const x of xs) {
    s.add(x);
  }
  return s.size;
}

test("collections", (t: Test) => {
  const m = wordCounts(["a", "b", "a"]);
  t.eq(m.size, 2);
  t.eq(totalCount(m), 3);
  t.eq(keysJoined(m), "a;b;");
  t.ok(m.has("a"));
  t.eq(uniqueCount(["x", "y", "x"]), 2);
  const xs: Array<i32> = [1, 2, 3];
  xs.push(4);
  t.eq(sum(xs), 10);
  t.eq(sumPrimes(), 17);
});

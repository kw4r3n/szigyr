// expect: ok
// stage: 2
// open-question: Q042
// open-question: Q047
// open-question: Q040
export function iota(alloc: Alloc, n: usize): Vec<u32> {
  "use owned";
  if (n > 1000000) {
    panic("too big");
  }
  const v = Vec.create<u32>(alloc, n);
  for (let i: usize = 0; i < n; i += 1) {
    v.push(u32(i));
  }
  return v;
}

export function sumVec(v: Ref<Vec<u32>>): u32 {
  "use owned";
  let s: u32 = 0;
  for (let i: usize = 0; i < v.length; i += 1) {
    s += v[i];
  }
  return s;
}

export function popOr(v: Mut<Vec<u32>>, d: u32): u32 {
  "use owned";
  const x = v.pop();
  if (x === null) {
    return d;
  }
  return x;
}

export function setFirst(v: Mut<Vec<u32>>, x: u32): void {
  "use owned";
  v[0] = x;
}

export function wipe(v: Mut<Vec<u32>>): void {
  "use owned";
  v.fill(7);
  v.clear();
}

test("vec ops", (t: Test) => {
  const alloc = TestAlloc.create();
  const v = iota(alloc, 4);
  t.eq(sumVec(v), 6);
  t.eq(popOr(v, 99), 3);
  t.eq(v.length, 3);
  setFirst(v, 10);
  t.eq(v[0], 10);
  wipe(v);
  t.eq(v.length, 0);
  t.eq(popOr(v, 99), 99);
});

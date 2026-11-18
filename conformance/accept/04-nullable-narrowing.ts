// expect: ok
// stage: 1
// open-question: Q025
// open-question: Q031
type User = { readonly name: string; readonly nick: string | null };

export function display(u: User): string {
  return u.nick ?? u.name;
}

export function nickLength(u: User): usize | null {
  return u.nick?.length;
}

export function firstOr(xs: ReadonlyArray<i32>, d: i32): i32 {
  if (xs.length === 0) {
    return d;
  }
  return xs[0];
}

export function position(xs: ReadonlyArray<string>, k: string): usize | null {
  return xs.indexOf(k);
}

export function describe(n: i32 | null): string {
  if (n === null) {
    return "none";
  }
  return `n=${n}`;
}

export function isPositive(n: i32 | null): boolean {
  return n !== null && n > 0;
}

export function orZero(n: i32 | null): i32 {
  const zero: i32 = 0;
  return n ?? zero;
}

test("nullable", (t: Test) => {
  t.eq(display({ name: "ann", nick: null }), "ann");
  t.eq(display({ name: "ann", nick: "an" }), "an");
  t.eq(describe(null), "none");
  t.eq(describe(5), "n=5");
  t.ok(isPositive(3));
  t.eq(orZero(null), 0);
  t.eq(firstOr([], 7), 7);
  t.eq(firstOr([4, 5], 7), 4);
  const l = nickLength({ name: "a", nick: "bob" });
  if (l !== null) {
    t.eq(l, 3);
  } else {
    t.ok(false);
  }
  t.ok(position(["a", "b"], "c") === null);
});

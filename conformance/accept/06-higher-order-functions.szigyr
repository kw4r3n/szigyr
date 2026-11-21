// expect: ok
// stage: 1
// open-question: Q045
// open-question: Q022
function double(x: i32): i32 {
  return x * 2;
}

export function apply(f: (x: i32) => i32, x: i32): i32 {
  return f(x);
}

export function compose(f: (x: i32) => i32, g: (x: i32) => i32): (x: i32) => i32 {
  return (x: i32) => g(f(x));
}

export function makeAdder(n: i32): (x: i32) => i32 {
  return (x: i32) => x + n;
}

export function evens(xs: Array<i32>): Array<i32> {
  return xs.filter((x: i32) => rem(x, 2) === 0);
}

export function doubled(xs: Array<i32>): Array<i32> {
  return xs.map(double);
}

export function total(xs: Array<i32>): i32 {
  return xs.reduce<i32>((acc: i32, x: i32) => acc + x, 0);
}

test("higher order", (t: Test) => {
  t.eq(apply(double, 4), 8);
  const h = compose(double, makeAdder(1));
  t.eq(h(5), 11);
  t.eq(evens([1, 2, 3, 4]), [2, 4]);
  t.eq(doubled([1, 2]), [2, 4]);
  t.eq(total([1, 2, 3]), 6);
});

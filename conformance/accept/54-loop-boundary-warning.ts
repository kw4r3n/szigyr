// expect: ok
// expect-warning: W8001 @ 28:13
// expect-warning: W8001 @ 30:10
// expect-warning: W8001 @ 31:28
// expect-warning: W8001 @ 33:5
// stage: 2
// open-question: Q187
function sq(x: f64): f64 {
  "use rt";
  return x * x;
}

function sumSq(n: u32): f64 {
  "use owned";
  let acc: f64 = 0;
  for (let i: u32 = 0; i < n; i += 1) acc += sq(f64(i)); // strict -> rt stays in C: no warning
  return acc;
}

function count(xs: Array<f64>): u32 {
  return u32(xs.length);
}

export function main(sys: System): void {
  const once = sq(2); // outside a loop: no warning
  let t: f64 = once;
  for (let i: f64 = sq(1); i < 3; i += 1) { // the initializer runs once: no warning
    t = t + sq(i);
  }
  while (sq(t) < 0) t = 0;
  for (let k: f64 = 0; k < sq(2); k += 1) t = t + f64(count([k]));
  do {
    sumSq(2);
  } while (t < 0);
  for (const x of [sq(3), 4]) { // the iterable is evaluated once: no warning
    const f = (y: f64): f64 => sq(y); // a function body runs when called: no warning
    t = t + f(x) + f64(count([x]));
  }
  sys.log.info(`${t}`);
}

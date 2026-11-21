// expect-output: 5 0 10
// expect-output: 0 10 5050
// stage: 1
// open-question: Q027
// open-question: Q056
// open-question: Q057
// open-question: Q059
function clamp(x: i32, lo: i32, hi: i32): i32 {
  requires(lo <= hi);
  ensures((r: i32) => r >= lo && r <= hi);
  if (x < lo) {
    return lo;
  }
  if (x > hi) {
    return hi;
  }
  return x;
}

function sumTo(n: i32): i32 {
  requires(n >= 0);
  ensures((r: i32) => r >= 0);
  ensures((r: i32) => r >= n || n === 0);
  let acc: i32 = 0;
  let i: i32 = 0;
  while (i < n) {
    invariant(acc >= 0);
    invariant(i >= 0);
    i += 1;
    acc += i;
  }
  return acc;
}

export function main(sys: System): void {
  sys.log.info(`${clamp(5, 0, 10)} ${clamp(-3, 0, 10)} ${clamp(99, 0, 10)}`);
  sys.log.info(`${sumTo(0)} ${sumTo(4)} ${sumTo(100)}`);
}

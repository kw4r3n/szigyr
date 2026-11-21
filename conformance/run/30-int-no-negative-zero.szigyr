// expect-output: Infinity,Infinity,Infinity,Infinity,Infinity,Infinity,Infinity,Infinity,Infinity,Infinity,Infinity
// expect-output: -Infinity
// stage: 1
// open-question: Q090
// open-question: Q140
// open-question: Q141
function inv(x: i32): f64 {
  return 1 / f64(x);
}

export function main(sys: System): void {
  const zero: i32 = 0;
  const lit: i32 = -0;
  const conv: i32 = i32(-0.0);
  const prod: i32 = zero * -1;
  const negated: i32 = -zero;
  const left: i32 = rem(zero, -5);
  const quot: i32 = divTrunc(zero, -3);
  const wrapped: i32 = wrapMul(zero, -1);
  const diff: i32 = zero - 0;
  const inArray: Array<i32> = [-0];
  const xs: Array<i32> = [lit, conv, prod, negated, left, quot, wrapped, diff, inArray[0], 0 * -1];
  xs.push(rem(-4, 2));
  sys.log.info(xs.map((x: i32): f64 => inv(x)).join(","));
  sys.log.info(`${1 / -0.0}`); // f64 keeps its negative zero
}

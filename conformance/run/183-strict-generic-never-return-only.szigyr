// expect-output: 2
// stage: 3
// open-question: Q233
// `never` may instantiate a type parameter that only reaches the return position (a diverging call); `null` may not.
function f<T>(x: i32): T { "use owned"; if (x > 0) { return panic("x"); } return panic("y"); }
function ok1(x: i32): i32 { "use owned"; return x + 1; }
export function main(sys: System): void {
  sys.log.info(`${ok1(1)}`);
  if (ok1(1) > 5) { f<never>(1); }
}

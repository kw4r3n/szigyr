// expect-output: 5
// expect-output: 105
// expect-output: 7
// stage: 2
function id<T>(x: T): T {
  "use owned";
  return x;
}
function twice(f: (x: u32) => u32, x: u32): u32 {
  "use owned";
  return f(f(x));
}
function inc(x: u32): u32 {
  "use owned";
  return x + 1;
}
function other(): u32 {
  const id = (x: u32): u32 => x + 100;
  return id(5);
}
function other2(): u32 {
  const twice = (x: u32): u32 => x + 2;
  return twice(5);
}
export function main(sys: System): void {
  sys.log.info(`${id<u32>(5)}`);
  sys.log.info(`${other()}`);
  sys.log.info(`${other2() + twice(inc, 0) - 2}`);
}

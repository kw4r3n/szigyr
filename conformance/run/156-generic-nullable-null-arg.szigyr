// expect-output: 1 1 null
// stage: 1
function g<T>(x: T | null, y: T): T {
  return y;
}
function h<T>(x: T | null): T | null {
  return x;
}
export function main(sys: System): void {
  const a = g(null, 1);
  const b: i32 = g(null, 1);
  const c: i32 | null = h(null);
  sys.log.info(`${a} ${b} ${c === null ? "null" : "ok"}`);
}

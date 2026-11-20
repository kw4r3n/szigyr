// expect: E4010 @ 9:14
// stage: 2
// open-question: Q240
type W<T> = Struct<{ readonly a: T }>;
function f<T>(x: T, n: i32): i32 {
  "use owned";
  if (n === 0) { return 0; }
  const p: W<T> = { a: x };
  return 1 + f<W<T>>(p, n - 1);
}
export function main(sys: System): void {
  sys.log.info(`${f<i32>(1, 3)}`);
}

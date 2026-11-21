// expect-output: 7
// stage: 1
// open-question: Q234
type A = { kind: "a"; v: i32 } | { kind: "b"; v: i32 };
function set(x: A): void { x.v = 7; }
export function main(sys: System): void {
  const a: A = { kind: "a", v: 1 };
  set(a);
  sys.log.info(`${a.v}`);
}

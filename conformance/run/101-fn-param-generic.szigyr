// expect-output: 42
// stage: 2
function incI(x: i32): i32 {
  "use owned";
  return x + 1;
}
function applyG<T>(f: (x: T) => T, v: T): T {
  "use owned";
  return f(v);
}
export function main(sys: System): void {
  sys.log.info(`${applyG(incI, 41)}`);
}

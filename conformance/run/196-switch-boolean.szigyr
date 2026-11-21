// expect-output: 1 2
// stage: 3
// A switch on a boolean runs in C like on JS (D140).
function f(flag: boolean): i32 {
  "use owned";
  switch (flag) {
    case true:
      return 1;
    default:
      return 2;
  }
  return 0;
}
export function main(sys: System): void {
  sys.log.info(`${f(true)} ${f(false)}`);
}

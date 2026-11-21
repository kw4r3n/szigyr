// expect-output: 1 0
// stage: 3
// A no-substitution template literal is a string literal value in a literal union (D140).
type K = "a" | "b";
function pick(n: i32): K {
  "use owned";
  if (n > 0) {
    return `a`;
  }
  return "b";
}
function code(k: K): i32 {
  "use owned";
  return k === "a" ? 1 : 0;
}
export function main(sys: System): void {
  sys.log.info(`${code(pick(1))} ${code(pick(0))}`);
}

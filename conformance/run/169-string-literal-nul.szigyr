// expect-output: 1 2 3 1
// stage: 2
type M = "c" | "c\u0000d";
function f(m: M): i32 {
  "use rt";
  switch (m) {
    case "c": return 1;
    case "c\u0000d": return 2;
  }
}
function pick(k: boolean): M {
  "use rt";
  return k ? "c\u0000d" : "c";
}
export function main(sys: System): void {
  const a: string = pick(true);
  const b: string = pick(false);
  sys.log.info(`${f("c")} ${f("c\u0000d")} ${a.length} ${b.length}`);
}

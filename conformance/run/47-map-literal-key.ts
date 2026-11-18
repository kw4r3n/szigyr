// expect-output: 2
// expect-output: warn
// stage: 1
// open-question: Q081
type Level = "info" | "warn";
export function main(sys: System): void {
  const m = new Map<Level, i32>();
  m.set("info", 1);
  m.set("warn", 2);
  sys.log.info(`${m.get("warn") ?? 0}`);
  const s = new Set<Level>();
  s.add("warn");
  s.forEach((x: Level): void => { sys.log.info(x); });
}

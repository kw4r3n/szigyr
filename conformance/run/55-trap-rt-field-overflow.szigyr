// expect-output: level=100
// expect-trap: T001 @ 9:11
// stage: 2
// open-question: Q002
type Gauge = Struct<{ level: i8; readonly step: i8 }>;

function raise(g: Mut<Gauge>): void {
  "use rt";
  g.level += g.step;
}

export function main(sys: System): void {
  const g: Gauge = { level: 50, step: 50 };
  raise(g);
  sys.log.info(`level=${g.level}`);
  raise(g);
  sys.log.info("unreachable");
}

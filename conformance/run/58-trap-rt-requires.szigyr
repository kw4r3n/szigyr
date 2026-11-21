// expect-output: 3
// expect-trap: T004 @ 9:3
// stage: 2
// open-question: Q002
type Range = Struct<{ readonly lo: u32; readonly hi: u32 }>;

function width(r: Range): u32 {
  "use rt";
  requires(r.lo <= r.hi);
  return r.hi - r.lo;
}

export function main(sys: System): void {
  sys.log.info(`${width({ lo: 2, hi: 5 })}`);
  sys.log.info(`${width({ lo: 5, hi: 2 })}`);
}

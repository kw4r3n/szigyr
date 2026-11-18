// expect: E2002 @ 8:21
// stage: 1
// open-question: Q133
export function main(sys: System): void {
  let x: string | null = null;
  const y: string | null = sys.clock.nowMs() > 0 ? "q" : null;
  const z = y ?? (x = "a");
  sys.log.info(`${x.length}`);
}

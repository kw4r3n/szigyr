// expect: E2002 @ 9:21
// stage: 1
// open-question: Q133
class A { m(s: string | null): usize { return 1; } }
export function main(sys: System): void {
  let x: string | null = null;
  const a: A | null = sys.clock.nowMs() < 0 ? new A() : null;
  const r = a?.m(x = "a");
  sys.log.info(`${x.length}`);
}

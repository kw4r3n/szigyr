// expect-output: true true
// expect-output: same=true len=4
// stage: 2
// open-question: Q040
function stamp(c: Clock, r: Random): boolean {
  "use owned";
  const t = c.nowMs();
  const x = r.nextF64();
  return t >= 0 && x >= 0 && x < 1;
}

function draws(r: Random, out: Mut<Vec<u32>>, n: i32): void {
  "use owned";
  for (let i: i32 = 0; i < n; i += 1) {
    out.push(r.nextU32());
  }
}

function fromSystem(sys: System, n: usize): Vec<f64> {
  "use owned";
  const v = Vec.create<f64>(sys.alloc, n);
  v.push(sys.clock.nowMs());
  return v;
}

export function main(sys: System): void {
  sys.log.info(`${stamp(sys.clock, sys.random)} ${fromSystem(sys, 2).length === 1}`);
  const a = Vec.create<u32>(sys.alloc, 1);
  const b = Vec.create<u32>(sys.alloc, 1);
  draws(SeededRandom.create(42), a, 4);
  const r = SeededRandom.create(42);
  for (let i: i32 = 0; i < 4; i += 1) {
    b.push(r.nextU32());
  }
  sys.log.info(`same=${a[0] === b[0] && a[3] === b[3]} len=${a.length}`);
}

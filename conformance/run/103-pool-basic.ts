// expect-output: len=2 cap=3 a=10 b=20
// expect-output: full=true len=3
// expect-output: removed=20 len=2 hasB=false
// expect-output: d=40 len=3 zero=0
// stage: 2
// open-question: Q188
// open-question: Q213
export function main(sys: System): void {
  const p = Pool.create<f32>(sys.alloc, 3);
  const a = p.insert(10);
  if (a === null) {
    sys.log.info("unexpected null a");
    return;
  }
  const b = p.insert(20);
  if (b === null) {
    sys.log.info("unexpected null b");
    return;
  }
  sys.log.info(`len=${p.length} cap=${p.capacity} a=${p.get(a)} b=${p.get(b)}`);
  const c = p.insert(30);
  const d0 = p.insert(40);
  sys.log.info(`full=${d0 === null} len=${p.length}`);
  const r = p.remove(b);
  sys.log.info(`removed=${r} len=${p.length} hasB=${p.has(b)}`);
  const d = p.insert(40);
  if (d === null) {
    sys.log.info("unexpected null d");
    return;
  }
  const z = Pool.create<f32>(sys.alloc, 0);
  sys.log.info(`d=${p.get(d)} len=${p.length} zero=${z.length}`);
}

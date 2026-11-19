// expect-output: pushed 10 20 30
// expect-output: popped 10 20
// expect-output: full: false
// expect-output: drained 30 40 50 60
// expect-output: empty: true
// expect-output: cap1: true false 9 true
// stage: 3
// open-question: Q199
function orNeg(v: i32 | null): i32 {
  if (v === null) {
    return -1;
  }
  return v;
}
export function main(sys: System): void {
  const { tx, rx } = Ring.create<i32>(sys.alloc, 4);
  tx.push(10);
  tx.push(20);
  tx.push(30);
  sys.log.info("pushed 10 20 30");
  const a = rx.pop();
  const b = rx.pop();
  sys.log.info(`popped ${orNeg(a)} ${orNeg(b)}`);
  tx.push(40);
  tx.push(50);
  tx.push(60);
  const full = tx.push(70);
  sys.log.info(`full: ${full}`);
  const c = rx.pop();
  const d = rx.pop();
  const e = rx.pop();
  const g = rx.pop();
  sys.log.info(`drained ${orNeg(c)} ${orNeg(d)} ${orNeg(e)} ${orNeg(g)}`);
  sys.log.info(`empty: ${rx.pop() === null}`);
  const one = Ring.create<i32>(sys.alloc, 1);
  const p1 = one.tx.push(9);
  const p2 = one.tx.push(10);
  const v = one.rx.pop();
  sys.log.info(`cap1: ${p1} ${p2} ${orNeg(v)} ${one.rx.pop() === null}`);
}

// expect-output: 7 8
// stage: 3
function orNeg(v: i32 | null): i32 {
  if (v === null) {
    return -1;
  }
  return v;
}
async function worker(port: Port<i32, RingTx<i32>>): Promise<void> {
  const tx = await port.recv();
  if (tx === null) {
    return;
  }
  tx.push(7);
  tx.push(8);
  port.send(0);
}
export async function main(sys: System): Promise<void> {
  const { tx, rx } = Ring.create<i32>(sys.alloc, 4);
  const p = sys.spawn.isolate(worker);
  p.send(tx);
  const done = await p.recv();
  const a = rx.pop();
  const b = rx.pop();
  sys.log.info(`${orNeg(a)} ${orNeg(b)}`);
}

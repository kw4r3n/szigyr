// expect-output: rt 42
// stage: 3
// open-question: Q199
function send(tx: Mut<RingTx<i32>>, x: i32): boolean {
  "use rt";
  return tx.push(x);
}
function recv(rx: Mut<RingRx<i32>>): i32 | null {
  "use rt";
  return rx.pop();
}
export function main(sys: System): void {
  const { tx, rx } = Ring.create<i32>(sys.alloc, 2);
  send(tx, 40);
  send(tx, 2);
  const a = recv(rx);
  const b = recv(rx);
  if (a === null || b === null) {
    sys.log.info("rt -1");
    return;
  }
  sys.log.info(`rt ${a + b}`);
}

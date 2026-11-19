// expect: E3005 @ 10:26
// stage: 3
function consume(t: RingTx<i32>): i32 {
  "use owned";
  return 1;
}
export function f(alloc: Alloc): boolean {
  "use owned";
  const { tx, rx } = Ring.create<i32>(alloc, 4);
  return tx.push(consume(tx));
}

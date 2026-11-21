// expect: E6002 @ 8:12
// stage: 3
// open-question: Q199
function send(tx: Mut<RingTx<i32>>): boolean {
  return tx.push(1);
}
export function f(x: i32, tx: Mut<RingTx<i32>>): i32 {
  requires(send(tx));
  return x;
}

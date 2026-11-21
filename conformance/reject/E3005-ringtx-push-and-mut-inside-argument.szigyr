// expect: E3005 @ 11:21
// stage: 3
function wn(t: Mut<RingTx<i32>>): i32 {
  "use owned";
  t.push(1);
  return 1;
}
export function f(alloc: Alloc): boolean {
  "use owned";
  const { tx, rx } = Ring.create<i32>(alloc, 4);
  return tx.push(wn(tx));
}

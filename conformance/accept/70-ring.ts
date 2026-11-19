// expect: ok
// stage: 3
// open-question: Q199
type Chan = Struct<{ tx: RingTx<f32>; rx: RingRx<f32> }>;

export function make(alloc: Alloc, cap: usize): RingPair<i32> {
  return Ring.create<i32>(alloc, cap);
}

export function send(tx: Mut<RingTx<i32>>, x: i32): boolean {
  "use owned";
  return tx.push(x);
}

export function recv(rx: Mut<RingRx<i32>>): i32 | null {
  "use owned";
  return rx.pop();
}

export function sendRt(tx: Mut<RingTx<f32>>, x: f32): boolean {
  "use rt";
  return tx.push(x);
}

export function recvRt(rx: Mut<RingRx<f32>>): f32 | null {
  "use rt";
  return rx.pop();
}

export function sendG<T>(tx: Mut<RingTx<T>>, x: T): boolean {
  "use owned";
  return tx.push(x);
}

export function makeG<T>(alloc: Alloc, cap: usize): RingPair<T> {
  "use owned";
  return Ring.create<T>(alloc, cap);
}

export function roundTrip(alloc: Alloc): i32 {
  const { tx, rx } = Ring.create<i32>(alloc, 4);
  tx.push(40);
  tx.push(2);
  const a = rx.pop();
  const b = rx.pop();
  if (a === null || b === null) {
    return -1;
  }
  return a + b;
}

export function drainPair(p: RingPair<i32>): i32 {
  "use owned";
  const { tx, rx } = p;
  tx.push(7);
  const v = rx.pop();
  return v === null ? 0 : v;
}

export function viaStruct(alloc: Alloc): f32 {
  const { tx, rx } = Ring.create<f32>(alloc, 2);
  const c: Chan = { tx, rx };
  c.tx.push(1.5);
  const v = c.rx.pop();
  return v === null ? 0 : v;
}

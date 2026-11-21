// expect-output: filled 8 sum 28
// expect-output: cycled 100 sum 4950
// expect-output: packed 118
// expect-output: handle 2.5
// expect-output: chan 11
// stage: 3
// open-question: Q199
type Pt = Struct<{ readonly x: i32; readonly y: i16; readonly b: boolean }>;
type Chan = Struct<{ tx: RingTx<i32>; rx: RingRx<i32> }>;

function fill(tx: Mut<RingTx<i32>>, n: i32): i32 {
  "use owned";
  let cnt: i32 = 0;
  for (let i: i32 = 0; i < n; i += 1) {
    if (tx.push(i)) {
      cnt += 1;
    }
  }
  return cnt;
}

function drain(rx: Mut<RingRx<i32>>): i32 {
  "use owned";
  let s: i32 = 0;
  for (;;) {
    const v = rx.pop();
    if (v === null) {
      return s;
    }
    s += v;
  }
}

function cycle(tx: Mut<RingTx<i32>>, rx: Mut<RingRx<i32>>, n: i32): i32 {
  "use owned";
  let s: i32 = 0;
  for (let i: i32 = 0; i < n; i += 1) {
    tx.push(i);
    const v = rx.pop();
    if (v !== null) {
      s += v;
    }
  }
  return s;
}

function packed(tx: Mut<RingTx<Pt>>, rx: Mut<RingRx<Pt>>): i32 {
  "use owned";
  tx.push({ x: 3, y: 5, b: true });
  tx.push({ x: 4, y: 6, b: false });
  const a = rx.pop();
  const b = rx.pop();
  if (a === null || b === null) {
    return -1;
  }
  let bonus: i32 = 0;
  if (a.b) {
    bonus = 100;
  }
  return a.x + b.x + i32(a.y) + i32(b.y) + bonus;
}

function fetch(rx: Mut<RingRx<Handle<f32>>>, p: Ref<Pool<f32>>): f32 {
  "use owned";
  const h = rx.pop();
  if (h === null) {
    return -1;
  }
  return p.get(h);
}

function chanUse(c: Mut<Chan>): i32 {
  "use owned";
  c.tx.push(5);
  c.tx.push(6);
  const a = c.rx.pop();
  const b = c.rx.pop();
  if (a === null || b === null) {
    return -1;
  }
  return a + b;
}

export function main(sys: System): void {
  const r1 = Ring.create<i32>(sys.alloc, 8);
  const f = fill(r1.tx, 10);
  const s = drain(r1.rx);
  sys.log.info(`filled ${f} sum ${s}`);
  const r2 = Ring.create<i32>(sys.alloc, 8);
  const cs = cycle(r2.tx, r2.rx, 100);
  sys.log.info(`cycled 100 sum ${cs}`);
  const r3 = Ring.create<Pt>(sys.alloc, 2);
  sys.log.info(`packed ${packed(r3.tx, r3.rx)}`);
  const pool = Pool.create<f32>(sys.alloc, 2);
  const h = pool.insert(2.5);
  const r4 = Ring.create<Handle<f32>>(sys.alloc, 2);
  if (h !== null) {
    r4.tx.push(h);
  }
  sys.log.info(`handle ${fetch(r4.rx, pool)}`);
  const { tx, rx } = Ring.create<i32>(sys.alloc, 4);
  const chan: Chan = { tx, rx };
  sys.log.info(`chan ${chanUse(chan)}`);
}

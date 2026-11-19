// expect-output: 3 2 104.5 10 14 41 42 3 27 2
// stage: 2
type P = Struct<{ readonly id: u8; readonly w: f64; readonly on: boolean }>;
type Ev = { readonly kind: "move"; readonly n: u16 } | { readonly kind: "stop" };
type Lv = "lo" | "hi";

function countTrue(s: Ref<Slice<boolean>>): i32 {
  "use rt";
  let n: i32 = 0;
  for (let i: usize = 0; i < s.length; i += 1) {
    if (s[i]) n += 1;
  }
  return n;
}

function tailCount(s: Ref<Slice<boolean>>): i32 {
  return countTrue(s.slice(1, 3));
}

function countHi(s: Ref<Slice<Lv>>): i32 {
  "use rt";
  let n: i32 = 0;
  for (let i: usize = 0; i < s.length; i += 1) {
    if (s[i] === "hi") n += 1;
  }
  return n;
}

function sumP(s: Ref<Slice<P>>): f64 {
  "use rt";
  return s[0].w + f64(s[1].id) + (s[1].on ? 100 : 0);
}

function sumEv(s: Ref<Slice<Ev>>): i32 {
  "use rt";
  let n: i32 = 0;
  for (let i: usize = 0; i < s.length; i += 1) {
    const e = s[i];
    if (e.kind === "move") n += i32(e.n);
  }
  return n;
}

function sumOpt(s: Ref<Slice<i32 | null>>): i32 {
  "use rt";
  let n: i32 = 0;
  for (let i: usize = 0; i < s.length; i += 1) {
    const v = s[i];
    if (v !== null) n += v;
  }
  return n;
}

function setH(s: Mut<Slice<Handle<i32>>>, h: Handle<i32>): void {
  "use rt";
  s[1] = h;
}

function getH(p: Ref<Pool<i32>>, s: Ref<Slice<Handle<i32>>>, i: usize): i32 {
  "use rt";
  return p.get(s[i]);
}

function bufLen(s: Ref<Slice<ArenaBuf<u8>>>): usize {
  "use rt";
  return s[0].length;
}

function sumU8(s: Ref<Slice<u8>>): u8 {
  "use rt";
  let n: u8 = 0;
  for (let i: usize = 0; i < s.length; i += 1) {
    n += s[i];
  }
  return n;
}

function useB(a: Ref<Arena>, s: Ref<Slice<ArenaBuf<u8>>>): u8 {
  "use rt";
  return sumU8(a.view(s[0]));
}

export function main(sys: System): void {
  const a = Arena.create(sys.alloc, 256);
  const pool = Pool.create<i32>(sys.alloc, 4);
  const h1 = pool.insert(41);
  const h2 = pool.insert(42);
  if (h1 === null || h2 === null) {
    return;
  }
  const pad = a.alloc<u32>(1, 7);
  const t = a.alloc<u8>(3, 9);
  if (pad === null || t === null) {
    return;
  }
  const bools = a.alloc<boolean>(3, true);
  const lvs = a.alloc<Lv>(2, "hi");
  const ps = a.alloc<P>(2, { id: 3, w: 1.5, on: true });
  const evs = a.alloc<Ev>(2, { kind: "move", n: 5 });
  const opts = a.alloc<i32 | null>(2, 7);
  const hs = a.alloc<Handle<i32>>(2, h1);
  const abs = a.alloc<ArenaBuf<u8>>(1, t);
  if (bools === null || lvs === null || ps === null || evs === null || opts === null || hs === null || abs === null) {
    return;
  }
  setH(a.view(hs), h2);
  sys.log.info(`${countTrue(a.view(bools))} ${countHi(a.view(lvs))} ${sumP(a.view(ps))} ${sumEv(a.view(evs))} ${sumOpt(a.view(opts))} ${getH(pool, a.view(hs), 0)} ${getH(pool, a.view(hs), 1)} ${bufLen(a.view(abs))} ${useB(a, a.view(abs))} ${tailCount(a.view(bools))}`);
}

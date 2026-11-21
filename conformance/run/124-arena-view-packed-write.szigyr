// expect-output: 2 1 111.5 6 33 41 3 7
// stage: 2
type P = Struct<{ readonly id: u8; readonly w: f64; readonly on: boolean }>;
type Ev = { readonly kind: "move"; readonly n: u16 } | { readonly kind: "stop" };
type Lv = "lo" | "hi";

function wrB(s: Mut<Slice<boolean>>): void {
  "use rt";
  s[0] = true;
  s[2] = true;
}

function countTrue(s: Ref<Slice<boolean>>): i32 {
  "use rt";
  let n: i32 = 0;
  for (let i: usize = 0; i < s.length; i += 1) {
    if (s[i]) n += 1;
  }
  return n;
}

function wrL(s: Mut<Slice<Lv>>): void {
  "use rt";
  s[1] = "hi";
}

function countHi(s: Ref<Slice<Lv>>): i32 {
  "use rt";
  let n: i32 = 0;
  for (let i: usize = 0; i < s.length; i += 1) {
    if (s[i] === "hi") n += 1;
  }
  return n;
}

function wrP(s: Mut<Slice<P>>): void {
  "use rt";
  s[0] = { id: 9, w: 2.5, on: true };
}

function sumP(s: Ref<Slice<P>>): f64 {
  "use rt";
  return s[0].w + f64(s[0].id) + (s[0].on ? 100 : 0);
}

function wrE(s: Mut<Slice<Ev>>): void {
  "use rt";
  s[0] = { kind: "move", n: 6 };
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

function wrO(s: Mut<Slice<i32 | null>>): void {
  "use rt";
  s[1] = 33;
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

function wrH(s: Mut<Slice<Handle<i32>>>, h: Handle<i32>): void {
  "use rt";
  s[0] = h;
}

function getH(p: Ref<Pool<i32>>, s: Ref<Slice<Handle<i32>>>): i32 {
  "use rt";
  return p.get(s[0]);
}

function wrA(s: Mut<Slice<ArenaBuf<u8>>>, b: ArenaBuf<u8>): void {
  "use rt";
  s[0] = b;
}

function bufLen(s: Ref<Slice<ArenaBuf<u8>>>): usize {
  "use rt";
  return s[0].length;
}

function rd(s: Ref<Slice<u32>>): u32 {
  "use rt";
  return s[0];
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
  const other = a.alloc<u8>(1, 1);
  if (pad === null || t === null || other === null) {
    return;
  }
  const bools = a.alloc<boolean>(3, false);
  const lvs = a.alloc<Lv>(2, "lo");
  const ps = a.alloc<P>(1, { id: 1, w: 0.5, on: false });
  const evs = a.alloc<Ev>(1, { kind: "stop" });
  const opts = a.alloc<i32 | null>(2, null);
  const hs = a.alloc<Handle<i32>>(1, h2);
  const abs = a.alloc<ArenaBuf<u8>>(1, other);
  if (bools === null || lvs === null || ps === null || evs === null || opts === null || hs === null || abs === null) {
    return;
  }
  wrB(a.view(bools));
  wrL(a.view(lvs));
  wrP(a.view(ps));
  wrE(a.view(evs));
  wrO(a.view(opts));
  wrH(a.view(hs), h1);
  wrA(a.view(abs), t);
  sys.log.info(`${countTrue(a.view(bools))} ${countHi(a.view(lvs))} ${sumP(a.view(ps))} ${sumEv(a.view(evs))} ${sumOpt(a.view(opts))} ${getH(pool, a.view(hs))} ${bufLen(a.view(abs))} ${rd(a.view(pad))}`);
}

// expect-output: done 7 2
// expect-output: get=10 rem=10 cnt=2
// stage: 2
function helper(x: Handle<f64>): f64 {
  "use rt";
  return 7;
}
function go(small: Mut<Pool<f64>>, big: Mut<Pool<f64>>, hs: Handle<f64>, hb: Handle<f64>): void {
  "use rt";
  let h: Handle<f64> = hs;
  small.set(h, helper(h = hb));
}
function pick(cnt: Mut<Vec<i32>>, h: Handle<i32>): Handle<i32> {
  "use rt";
  cnt[0] += 1;
  return h;
}
function getOnce(p: Ref<Pool<i32>>, cnt: Mut<Vec<i32>>, h: Handle<i32>): i32 {
  "use rt";
  return p.get(pick(cnt, h));
}
function remOnce(p: Mut<Pool<i32>>, cnt: Mut<Vec<i32>>, h: Handle<i32>): i32 {
  "use rt";
  return p.remove(pick(cnt, h));
}
export function main(sys: System): void {
  const small = Pool.create<f64>(sys.alloc, 2);
  const big = Pool.create<f64>(sys.alloc, 4096);
  const hs = small.insert(1);
  let hb: Handle<f64> | null = null;
  for (let i = 0; i < 4000; i += 1) {
    hb = big.insert(2);
  }
  if (hs === null || hb === null) { return; }
  go(small, big, hs, hb);
  sys.log.info(`done ${small.get(hs)} ${big.get(hb)}`);
  const p2 = Pool.create<i32>(sys.alloc, 2);
  const h2 = p2.insert(10);
  if (h2 === null) { return; }
  const cnt = Vec.create<i32>(sys.alloc, 1);
  cnt.push(0);
  const g = getOnce(p2, cnt, h2);
  const r = remOnce(p2, cnt, h2);
  sys.log.info(`get=${g} rem=${r} cnt=${cnt[0]}`);
}

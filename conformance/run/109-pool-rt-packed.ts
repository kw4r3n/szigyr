// expect-output: sum=9
// expect-output: sum2=10 len=1
// expect-output: del=5 len=0 has=false
// stage: 2
// open-question: Q188
type Pt = Struct<{ readonly x: f32; readonly y: f32 }>;
function put(p: Mut<Pool<Pt>>, x: f32): Handle<Pt> | null {
  "use rt";
  return p.insert({ x: x, y: x * 2 });
}
function sum(p: Ref<Pool<Pt>>, h: Handle<Pt>): f32 {
  "use rt";
  const v = p.get(h);
  return v.x + v.y;
}
function upd(p: Mut<Pool<Pt>>, h: Handle<Pt>, x: f32): void {
  "use rt";
  p.set(h, { x: x, y: x });
}
function del(p: Mut<Pool<Pt>>, h: Handle<Pt>): f32 {
  "use rt";
  return p.remove(h).x;
}
export function main(sys: System): void {
  const p = Pool.create<Pt>(sys.alloc, 2);
  const h = put(p, 3);
  if (h === null) {
    return;
  }
  const hs = Vec.create<Handle<Pt>>(sys.alloc, 1);
  hs.push(h);
  sys.log.info(`sum=${sum(p, hs[0])}`);
  upd(p, h, 5);
  sys.log.info(`sum2=${sum(p, h)} len=${p.length}`);
  sys.log.info(`del=${del(p, h)} len=${p.length} has=${p.has(h)}`);
}

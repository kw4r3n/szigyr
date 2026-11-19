// expect-output: 42 3
// stage: 3
// backend: c
type State = Struct<{ rx: RingRx<i32>; readonly tag: i32; h: CHandle<i32> }>;
type R = Struct<{ a: i32; b: i32 }>;
function useState(s: Mut<State>): i32 {
  "use rt";
  const v = s.rx.pop();
  if (v === null) { return s.tag; }
  return v + s.tag;
}
function go(alloc: Alloc): R {
  "use owned";
  "use unsafe";
  const { tx, rx } = Ring.create<i32>(alloc, 4);
  tx.push(30);
  const inner = Ptr.box<i32>(alloc, 3);
  const st: State = { rx, tag: 12, h: CHandle.create(inner) };
  const p = Ptr.box(alloc, st);
  const a = useState(p.borrow());
  const st2 = p.unbox();
  const b = st2.h.get().read();
  return { a, b };
}
export function main(sys: System): void {
  const r = go(sys.alloc);
  sys.log.info(`${r.a} ${r.b}`);
}
